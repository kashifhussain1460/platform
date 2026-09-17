import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { ConnectWhatsAppAccountDto, WhatsAppAccountDto } from '@vaep/types';
import { CryptoService } from '../../../common/crypto/crypto.service';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditLogService } from '../../audit/audit-log.service';
import { TwilioWhatsappClientService } from './twilio-whatsapp-client.service';

/**
 * The dedicated connect surface for `WhatsAppAccount` (Task 13).
 *
 * `WhatsAppAccount` is its own top-level Prisma model — not a config blob on
 * `InstalledSkill` — and there is no FK between the two tables. Tracing
 * `SkillsService.connectSkill` confirmed it only ever writes
 * `InstalledSkill.credentials`/`config`, so the generic Skill Config `api_key`
 * connect flow has genuinely no path to create or update a `WhatsAppAccount`
 * row. `WhatsappEngineAdapter.connect()` already documents this and throws
 * `EngineCapabilityUnsupportedError`, pointing at "a direct Twilio-credentials
 * form on the frontend" — this service is that form's backend.
 *
 * `twilioAuthToken` is encrypted at rest via `CryptoService` (matching the
 * `InstalledSkill.credentials` pattern) and never returned raw.
 *
 * VERIFY BEFORE CONNECTED (I3). This route used to write `status: 'CONNECTED'`
 * without ever exercising the credentials, so a typo'd Account SID or a
 * revoked Auth Token produced a green "Connected" badge and a WhatsApp sender
 * that could never send or receive anything — the same over-claim
 * `SkillsService.verifyConnection` / `providers/provider-adapter.ts` exist to
 * stop for every other provider (`smtp.adapter.ts` does a real AUTH check for
 * exactly this reason). One authenticated Twilio read now stands between the
 * form and CONNECTED.
 */
@Injectable()
export class WhatsappAccountsService {
  private readonly logger = new Logger(WhatsappAccountsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly twilioClient: TwilioWhatsappClientService,
    private readonly audit: AuditLogService,
  ) {}

  async connect(
    companyId: string,
    dto: ConnectWhatsAppAccountDto,
  ): Promise<WhatsAppAccountDto> {
    const employeeId = dto.employeeId ?? null;
    if (employeeId) {
      const employee = await this.prisma.aiEmployee.findFirst({
        where: { id: employeeId, companyId },
        select: { id: true },
      });
      if (!employee) {
        throw new NotFoundException('Employee not found');
      }
    }

    // The real credential check: fetch the Twilio account these credentials
    // claim to be. A bad SID or token throws (401/404) and nothing is written
    // as CONNECTED. Deliberately BEFORE the upsert — a failed verification
    // must not leave a half-written row behind.
    await this.verifyTwilioCredentials(companyId, dto);

    const row = await this.prisma.whatsAppAccount.upsert({
      where: {
        companyId_whatsappSenderNumber: {
          companyId,
          whatsappSenderNumber: dto.whatsappSenderNumber,
        },
      },
      create: {
        companyId,
        employeeId,
        twilioAccountSid: dto.twilioAccountSid,
        twilioAuthToken: this.crypto.encrypt(dto.twilioAuthToken),
        whatsappSenderNumber: dto.whatsappSenderNumber,
        status: 'CONNECTED',
      },
      update: {
        employeeId,
        twilioAccountSid: dto.twilioAccountSid,
        twilioAuthToken: this.crypto.encrypt(dto.twilioAuthToken),
        status: 'CONNECTED',
      },
    });

    // The Skills catalog list, EmployeeSkillPicker and the wizard's own
    // initial-stage check all read InstalledSkill.connectionStatus, not
    // WhatsAppAccount.status — without this, a real successful connect here
    // would still show as "Not connected" everywhere outside this form.
    // updateMany (not update): a company can reach this dedicated connect
    // form before ever installing the catalog entry, so there may be no
    // matching row yet — that's a no-op, not an error.
    // employeeId is included in the where-clause (same value used above) so
    // this only flips the InstalledSkill row scoped to the SAME employee (or
    // company-wide, if null) whose credentials were just verified — not every
    // whatsapp row in the company. InstalledSkill has a real per-employee
    // dimension (@@unique([companyId, skillKey, employeeId])), so without
    // this a verify for one employee's number would falsely mark every other
    // whatsapp InstalledSkill row CONNECTED too.
    await this.prisma.installedSkill.updateMany({
      where: { companyId, skillKey: 'whatsapp', employeeId },
      data: { connectionStatus: 'CONNECTED' },
    });

    await this.audit.record({
      companyId,
      action: 'connector.verified',
      entityType: 'WhatsAppAccount',
      entityId: row.id,
      metadata: {
        provider: 'whatsapp',
        twilioAccountSid: dto.twilioAccountSid,
        whatsappSenderNumber: dto.whatsappSenderNumber,
        employeeId,
      },
    });

    return this.toDto(row);
  }

  /**
   * One authenticated Twilio read — `GET /Accounts/{sid}` via the SDK — which
   * is the standard "are these credentials real?" probe.
   *
   * Failure is reported to the caller as a 400 carrying Twilio's own reason
   * (rather than a generic error), and audited as `connector.verify_failed` to
   * match the shape `SkillsService.verifyConnection` records for every generic
   * connector.
   */
  private async verifyTwilioCredentials(
    companyId: string,
    dto: ConnectWhatsAppAccountDto,
  ): Promise<void> {
    try {
      await this.twilioClient.verifyCredentials({
        companyId,
        accountSid: dto.twilioAccountSid,
        authToken: dto.twilioAuthToken,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Twilio credential verification failed for company=${companyId} sid=${dto.twilioAccountSid}: ${reason}`,
      );
      await this.audit.record({
        companyId,
        action: 'connector.verify_failed',
        entityType: 'WhatsAppAccount',
        metadata: {
          provider: 'whatsapp',
          twilioAccountSid: dto.twilioAccountSid,
          whatsappSenderNumber: dto.whatsappSenderNumber,
          reason,
        },
      });
      throw new BadRequestException(
        `Twilio rejected these credentials — the account was not connected. (${reason})`,
      );
    }
  }

  /** The company's current WhatsApp account (company-wide, employeeId=null), if any. */
  async getAccount(companyId: string): Promise<WhatsAppAccountDto | null> {
    const row = await this.prisma.whatsAppAccount.findFirst({
      where: { companyId },
      orderBy: { createdAt: 'desc' },
    });
    return row ? this.toDto(row) : null;
  }

  private toDto(row: {
    id: string;
    companyId: string;
    employeeId: string | null;
    twilioAccountSid: string;
    whatsappSenderNumber: string;
    status: string;
    createdAt: Date;
  }): WhatsAppAccountDto {
    return {
      id: row.id,
      companyId: row.companyId,
      employeeId: row.employeeId,
      twilioAccountSid: row.twilioAccountSid,
      whatsappSenderNumber: row.whatsappSenderNumber,
      status: row.status as WhatsAppAccountDto['status'],
      createdAt: row.createdAt.toISOString(),
    };
  }
}
