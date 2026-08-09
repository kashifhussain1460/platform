import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { PostizClientService } from './postiz-client.service';

/**
 * The Postiz reconciliation sweep, as a plain (always-provided) service so it can
 * be driven BOTH by the BullMQ repeatable (worker deployments) AND by the Vercel
 * cron route (serverless, where no worker exists). Postiz's own webhook is
 * unsigned/no-retry (postiz-engine.md §13), so this sweep is the source of truth
 * for ScheduledPost status — it MUST run on every deployment shape, not only when
 * `QUEUE_WORKERS_ENABLED` is set.
 *
 * Cross-tenant by design (system reconciliation), mirroring the Gmail/approval
 * sweeps: no companyId filter; each row carries its own companyId.
 */
@Injectable()
export class MarketingSyncService {
  private readonly logger = new Logger(MarketingSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly postizClient: PostizClientService,
  ) {}

  async sweep(): Promise<{ reconciled: number }> {
    const pending = await this.prisma.scheduledPost.findMany({
      where: { status: 'SCHEDULED' },
      take: 100,
    });
    if (pending.length === 0) return { reconciled: 0 };

    // ONE list call per sweep, not one per pending post — avoids N calls against
    // Postiz's own rate limit (postiz-engine.md §14: 90/hour instance-wide).
    const postizPosts = await this.postizClient.listPosts();
    const byId = new Map(postizPosts.map((p) => [p.id, p]));

    let reconciled = 0;
    for (const post of pending) {
      if (!post.postizPostId) continue;
      const remote = byId.get(post.postizPostId);
      if (!remote) continue; // not found this sweep — leave SCHEDULED, retry next
      if (remote.state === 'PUBLISHED') {
        await this.prisma.publishedPost.create({
          data: {
            companyId: post.companyId,
            socialAccountId: post.socialAccountId,
            scheduledPostId: post.id,
            platformPostId: remote.releaseId ?? null,
            permalink: remote.releaseURL ?? null,
          },
        });
        await this.prisma.scheduledPost.update({
          where: { id: post.id },
          data: { status: 'PUBLISHED' },
        });
        reconciled += 1;
      } else if (remote.state === 'ERROR') {
        await this.prisma.scheduledPost.update({
          where: { id: post.id },
          data: { status: 'FAILED' },
        });
        reconciled += 1;
      }
      // state QUEUE/DRAFT → still pending, leave as SCHEDULED, no action.
    }
    this.logger.debug(
      `marketing-sync swept ${pending.length} pending, reconciled ${reconciled}`,
    );
    return { reconciled };
  }
}
