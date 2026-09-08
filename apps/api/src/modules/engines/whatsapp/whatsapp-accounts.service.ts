import { Injectable, NotFoundException } from '@nestjs/common';
import type { ConnectWhatsAppAccountDto, WhatsAppAccountDto } from '@vaep/types';
import { CryptoService } from '../../../common/crypto/crypto.service';
import { PrismaService } from '../../../common/prisma/prisma.service';

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
 */
@Injectable()
export class WhatsappAccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
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
    return this.toDto(row);
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
