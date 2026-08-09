import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type {
  AssistSessionDto,
  AssistSessionSummaryDto,
  AssistSuggestionDto,
  WorkflowDefinition,
  WorkflowDto,
} from '@vaep/types';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditLogService } from '../audit/audit-log.service';
import type { AuthenticatedUser } from '../auth/auth.provider';
import { WorkflowsService } from '../workflows/workflows.service';
import {
  AssistAgentService,
  type AssistEventSink,
} from './agent/assist-agent.service';
import { ASSIST_MAX_TURNS, ASSIST_TITLE_MAX } from './assist.constants';
import type {
  AcceptAssistSessionDto,
  CreateAssistSessionDto,
  ListAssistSessionsDto,
} from './dto/assist.dto';
import {
  toAssistSessionDto,
  toAssistSessionSummaryDto,
} from './assist.mapper';

/**
 * Orlixa AI Assist — session lifecycle (doc 30 wave A0).
 *
 * This layer owns the CONVERSATION, never the agent. The agent (wave A2) mutates
 * `draftDefinition` through its tools; everything here is create / read / accept
 * / delete, so the two can be built and tested independently.
 *
 * Two rules are enforced here rather than by a decorator, because a decorator
 * cannot express them:
 *  - **Author privacy** — a session is readable only by the user who started it
 *    (doc 30 §7). Admins may delete one, never read it: a half-built draft is
 *    working material and the transcript carries the author's raw business
 *    context.
 *  - **Accept is admin-only** — creating a real workflow matches
 *    `POST /workflows` (`@Roles('OWNER','ADMIN')`). Building is member-level so
 *    anyone can explore; only an admin can land the result. This deliberately
 *    avoids repeating G36, where `/workflows/generate` let a MEMBER generate a
 *    draft they could then never save.
 */
@Injectable()
export class AssistService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workflows: WorkflowsService,
    private readonly auditLog: AuditLogService,
    private readonly agent: AssistAgentService,
  ) {}

  async create(
    companyId: string,
    user: AuthenticatedUser,
    dto: CreateAssistSessionDto,
  ): Promise<AssistSessionDto> {
    // A target workflow must belong to this tenant — never trust a client id.
    if (dto.targetWorkflowId) {
      await this.assertWorkflowInTenant(companyId, dto.targetWorkflowId);
    }

    const session = await this.prisma.assistSession.create({
      data: {
        companyId,
        userId: user.userId,
        title: titleFrom(dto.prompt, dto.targetWorkflowId),
        targetWorkflowId: dto.targetWorkflowId ?? null,
        originRunId: dto.originRunId ?? null,
        // The opening prompt is stored as the first turn but NOT answered here —
        // the client opens the stream and the agent replies there (doc 30 §8).
        ...(dto.prompt
          ? { messages: { create: [{ companyId, role: 'USER' as const, content: dto.prompt }] } }
          : {}),
      },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });

    await this.auditLog.record({
      companyId,
      actorUserId: user.userId,
      action: 'assist.session.create',
      entityType: 'AssistSession',
      entityId: session.id,
    });

    return toAssistSessionDto(session);
  }

  async list(
    companyId: string,
    user: AuthenticatedUser,
    query: ListAssistSessionsDto,
  ): Promise<AssistSessionSummaryDto[]> {
    const rows = await this.prisma.assistSession.findMany({
      // Scoped to the AUTHOR, not the company — see the class doc.
      where: {
        companyId,
        userId: user.userId,
        ...(query.status ? { status: query.status } : {}),
      },
      orderBy: { updatedAt: 'desc' },
      take: Math.min(query.limit ?? 30, 100),
    });
    return rows.map(toAssistSessionSummaryDto);
  }

  async get(
    companyId: string,
    user: AuthenticatedUser,
    id: string,
  ): Promise<AssistSessionDto> {
    const session = await this.prisma.assistSession.findFirst({
      where: { id, companyId },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
    if (!session) throw new NotFoundException('Assist session not found');
    // 404 rather than 403 for another author's session: whether a session
    // exists is itself information the requester has no claim to.
    if (session.userId !== user.userId) {
      throw new NotFoundException('Assist session not found');
    }
    return toAssistSessionDto(session);
  }

  /**
   * Turn the draft into a REAL workflow. The one place a conversation becomes
   * something that can run — deliberately explicit, human and role-gated.
   */
  async accept(
    companyId: string,
    user: AuthenticatedUser,
    id: string,
    dto: AcceptAssistSessionDto,
  ): Promise<WorkflowDto> {
    if (user.role !== 'OWNER' && user.role !== 'ADMIN') {
      throw new ForbiddenException(
        'Only owners and admins can create workflows',
      );
    }

    const session = await this.get(companyId, user, id);
    const definition = session.draftDefinition;
    if (!definition || definition.nodes.length === 0) {
      throw new NotFoundException(
        'This session has no workflow to create yet — describe what you want built first.',
      );
    }

    // Goes through the ORDINARY create path: same validation, same audit, same
    // ownership. There is no assist-specific bypass, so a workflow built by the
    // agent is indistinguishable from a hand-built one (doc 30 AD-30-10).
    const workflow = await this.workflows.create(
      companyId,
      {
        name: dto.name,
        description: dto.description,
        definition: definition as WorkflowDefinition,
      },
      user.userId,
    );

    await this.prisma.assistSession.update({
      where: { id },
      data: { createdWorkflowId: workflow.id, status: 'COMPLETED' },
    });
    // Provenance: answers "who built this and how" long after the chat is gone.
    await this.prisma.workflow.update({
      where: { id: workflow.id },
      data: { assistSessionId: id },
    });

    await this.auditLog.record({
      companyId,
      actorUserId: user.userId,
      action: 'assist.session.accept',
      entityType: 'Workflow',
      entityId: workflow.id,
      metadata: { assistSessionId: id },
    });

    return workflow;
  }

  /**
   * Run one conversational turn: persist what the user said, let the agent work,
   * persist its reply. Returns the full session so the client re-renders from one
   * authoritative payload rather than patching state from a delta.
   *
   * Non-streaming in wave A2. Wave A3 keeps this orchestration and swaps the
   * delivery for SSE, which is why persistence lives here and not in the agent.
   */
  async turn(
    companyId: string,
    user: AuthenticatedUser,
    id: string,
    text: string,
    sink?: AssistEventSink,
  ): Promise<AssistSessionDto> {
    // Reuse `get` for its author + tenant checks — one place decides who may
    // touch a session.
    const existing = await this.get(companyId, user, id);

    if (existing.status === 'EXHAUSTED') {
      throw new ForbiddenException(
        'This conversation has used up its budget. Start a new one — your workflow so far is saved.',
      );
    }
    const turnsSoFar = existing.messages.filter((m) => m.role === 'USER').length;
    if (turnsSoFar >= ASSIST_MAX_TURNS) {
      throw new ForbiddenException(
        'This conversation has gone on a long way. Start a new one and we can carry on from the workflow you have.',
      );
    }

    // An empty text means "the opening prompt is already stored, just run" —
    // used when a session is created with a prompt and the client immediately
    // opens the stream instead of sending the same words twice.
    if (text.trim()) {
      await this.prisma.assistMessage.create({
        data: { sessionId: id, companyId, role: 'USER', content: text },
      });
    }

    const result = await this.agent.runTurn(companyId, user.userId, id, sink);

    await this.prisma.assistMessage.create({
      data: {
        sessionId: id,
        companyId,
        role: 'ASSISTANT',
        content: result.reply,
        // Cast at the Prisma boundary only: these are plain serialisable
        // objects, but Prisma's InputJsonValue can't see that through our DTOs.
        metadata: {
          toolTrace: result.toolTrace,
          graphVersion: result.graphVersion,
          graphChanged: result.graphChanged,
          unresolved: result.unresolved,
          tests: result.tests,
          finished: result.finished,
          ...(result.stoppedBecause ? { stoppedBecause: result.stoppedBecause } : {}),
        } as unknown as Prisma.InputJsonObject,
      },
    });

    // A CONNECTION message renders the in-chat Skill card and lets a reload show
    // it (doc 30 §12). Persisted as its own row so it survives independently of
    // the reply text; the card refreshes live status from GET /skills/requirements.
    if (result.connectionRequirements.length > 0) {
      const missing = result.connectionRequirements.filter(
        (r) => r.status !== 'READY',
      ).length;
      await this.prisma.assistMessage.create({
        data: {
          sessionId: id,
          companyId,
          role: 'CONNECTION',
          content:
            missing > 0
              ? `This workflow needs ${missing} skill ${missing === 1 ? 'connection' : 'connections'} before it can run.`
              : 'All the skills this workflow needs are connected.',
          metadata: {
            requirements: result.connectionRequirements,
            skillKeys: result.connectionRequirements.map((r) => r.skillKey),
          } as unknown as Prisma.InputJsonObject,
        },
      });
    }

    return this.get(companyId, user, id);
  }

  async remove(
    companyId: string,
    user: AuthenticatedUser,
    id: string,
  ): Promise<void> {
    const session = await this.prisma.assistSession.findFirst({
      where: { id, companyId },
    });
    if (!session) throw new NotFoundException('Assist session not found');

    const isAdmin = user.role === 'OWNER' || user.role === 'ADMIN';
    if (session.userId !== user.userId && !isAdmin) {
      throw new NotFoundException('Assist session not found');
    }

    // Messages cascade. `createdWorkflowId` deliberately does NOT — the workflow
    // outlives the conversation that produced it.
    await this.prisma.assistSession.delete({ where: { id } });
    await this.auditLog.record({
      companyId,
      actorUserId: user.userId,
      action: 'assist.session.delete',
      entityType: 'AssistSession',
      entityId: id,
    });
  }

  /**
   * Entry-screen chips. GROUNDED in what this tenant actually owns — an HR+
   * Marketing company is offered HR and Marketing starts — rather than a
   * hardcoded list that suggests things they cannot build.
   */
  async suggestions(companyId: string): Promise<AssistSuggestionDto[]> {
    const employees = await this.prisma.aiEmployee.findMany({
      where: { companyId, status: 'ACTIVE' },
      select: { role: true },
      distinct: ['role'],
    });

    const roles = new Set<string>(employees.map((e) => e.role));
    const picked = SUGGESTIONS_BY_ROLE.filter((s) => roles.has(s.role)).slice(0, 4);
    // A brand-new tenant with no employees still needs somewhere to start.
    return (picked.length > 0 ? picked : GENERIC_SUGGESTIONS).map(
      ({ id, label, prompt }) => ({ id, label, prompt }),
    );
  }

  private async assertWorkflowInTenant(
    companyId: string,
    workflowId: string,
  ): Promise<void> {
    const found = await this.prisma.workflow.findFirst({
      where: { id: workflowId, companyId },
      select: { id: true },
    });
    if (!found) throw new NotFoundException('Workflow not found');
  }
}

/** First user message, clipped — the session list needs a readable label. */
function titleFrom(prompt?: string, targetWorkflowId?: string): string {
  const clean = prompt?.replace(/\s+/g, ' ').trim();
  if (clean) {
    return clean.length <= ASSIST_TITLE_MAX
      ? clean
      : `${clean.slice(0, ASSIST_TITLE_MAX).trimEnd()}…`;
  }
  return targetWorkflowId ? 'Editing a workflow' : 'New workflow';
}

type Suggestion = AssistSuggestionDto & { role: string };

const SUGGESTIONS_BY_ROLE: Suggestion[] = [
  { id: 'hr-cv', role: 'HR', label: 'Screen incoming CVs', prompt: 'When a CV arrives by email, have HR score it and tell me who is worth interviewing.' },
  { id: 'hr-leave', role: 'HR', label: 'Handle leave requests', prompt: 'When someone requests leave, check the policy, get a manager to approve it, and reply to them.' },
  { id: 'mkt-campaign', role: 'MARKETING', label: 'Plan a campaign', prompt: 'Draft a campaign plan for a product launch, get it approved, then save it.' },
  { id: 'mkt-social', role: 'MARKETING', label: 'Schedule social posts', prompt: 'Write a week of social posts from a blog article and schedule them once approved.' },
  { id: 'sales-lead', role: 'SALES', label: 'Follow up on new leads', prompt: 'When a new lead comes in, research them and draft a first outreach email for approval.' },
  { id: 'support-triage', role: 'SUPPORT', label: 'Triage support tickets', prompt: 'When a support email arrives, look up the answer in our knowledge base and draft a reply.' },
  { id: 'fin-invoice', role: 'ACCOUNTANT', label: 'Process invoices', prompt: 'When an invoice arrives, pull out the amount and due date and route it for approval.' },
];

const GENERIC_SUGGESTIONS: Suggestion[] = [
  { id: 'gen-email', role: '', label: 'Reply to incoming email', prompt: 'When an email arrives, draft a reply for me to approve before it sends.' },
  { id: 'gen-approve', role: '', label: 'Add an approval step', prompt: 'Build something that asks a manager to approve before it takes any real action.' },
  { id: 'gen-summarise', role: '', label: 'Summarise a document', prompt: 'When a document is uploaded, summarise it and post the summary to my team.' },
  { id: 'gen-schedule', role: '', label: 'Run something on a schedule', prompt: 'Every Monday morning, put together a summary of last week and send it to me.' },
];
