import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  LeadDetailDto,
  LeadDto,
  LeadSource,
  LeadStatus,
  MessageMetadataDto,
} from '@vaep/types';
import { PrismaService } from '../../common/prisma/prisma.service';

/**
 * The human-facing read surface over `Lead` (Task 1's model).
 *
 * The WhatsApp Sales AI Employee's tools already create and update `Lead`
 * rows (`real-skill-executor.ts`), but until this module there was no
 * tenant-facing API over any of it — the same defect class the Marketing
 * workspace closed for `ScheduledPost`/`SocialAccount`: an AI could be
 * qualifying real prospects with no screen showing a human what came in or
 * what the AI said to them.
 *
 * Read-only for now (§ this task adds `lead:read` only). Every query is
 * scoped by `companyId` so a wrong id is a 404, never another company's lead.
 */
@Injectable()
export class LeadsService {
  constructor(private readonly prisma: PrismaService) {}

  async listLeads(
    companyId: string,
    opts: { status?: LeadStatus; source?: LeadSource } = {},
  ): Promise<LeadDto[]> {
    const rows = await this.prisma.lead.findMany({
      where: {
        companyId,
        ...(opts.status ? { status: opts.status } : {}),
        ...(opts.source ? { source: opts.source } : {}),
      },
      orderBy: [{ createdAt: 'desc' }],
    });
    return rows.map((r) => this.toLeadDto(r));
  }

  /** One lead with its full conversation thread, for the Lead Detail screen. */
  async getLead(companyId: string, id: string): Promise<LeadDetailDto> {
    const row = await this.prisma.lead.findFirst({
      where: { id, companyId },
      include: {
        conversation: {
          include: { messages: { orderBy: { createdAt: 'asc' } } },
        },
      },
    });
    if (!row) {
      throw new NotFoundException('Lead not found for this company');
    }

    return {
      ...this.toLeadDto(row),
      conversation: row.conversation
        ? {
            id: row.conversation.id,
            employeeId: row.conversation.employeeId,
            title: row.conversation.title,
            createdAt: row.conversation.createdAt.toISOString(),
            messages: row.conversation.messages.map((m) => ({
              id: m.id,
              companyId: m.companyId,
              conversationId: m.conversationId,
              role: m.role,
              content: m.content,
              metadata: (m.metadata ?? null) as MessageMetadataDto | null,
              createdAt: m.createdAt.toISOString(),
            })),
          }
        : null,
    };
  }

  private toLeadDto(row: {
    id: string;
    source: string;
    phone: string;
    name: string | null;
    email: string | null;
    status: string;
    qualificationData: unknown;
    conversationId: string | null;
    assignedToUserId: string | null;
    createdAt: Date;
    lastContactedAt: Date | null;
  }): LeadDto {
    return {
      id: row.id,
      source: row.source as LeadSource,
      phone: row.phone,
      name: row.name,
      email: row.email,
      status: row.status as LeadStatus,
      qualificationData: (row.qualificationData ?? null) as LeadDto['qualificationData'],
      conversationId: row.conversationId,
      assignedToUserId: row.assignedToUserId,
      createdAt: row.createdAt.toISOString(),
      lastContactedAt: row.lastContactedAt ? row.lastContactedAt.toISOString() : null,
    };
  }
}
