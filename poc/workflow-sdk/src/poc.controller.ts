/**
 * POC ONLY — NOT PRODUCTION.
 *
 * Drives every POC case over HTTP so the test script can start runs, kill the
 * process, restart it and keep asking questions.
 */
import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { getRun, resumeHook, start } from 'workflow/api';
import { decideApproval, listApprovals } from './orlixa/approval-store';
import { VERSIONS } from './orlixa/definitions';
import { providerState, resetProvider } from './orlixa/mock-external-api';
import { readLedger, record } from './orlixa/recorder';
import { pocBasic } from './workflows/poc-01-basic';
import { pocFatal, pocRetry } from './workflows/poc-02-retry';
import { pocWait } from './workflows/poc-03-wait';
import { pocSideEffect } from './workflows/poc-05-side-effect';
import { pocIdempotentTrigger } from './workflows/poc-06-idempotency';
import { runOrlixaDefinition } from './workflows/poc-07-dynamic';

@Controller('poc')
export class PocController {
  @Get('health')
  health() {
    return { ok: true, pid: process.pid, world: process.env.WORKFLOW_TARGET_WORLD ?? 'local' };
  }

  @Post('01-basic')
  async basic(@Body() body: { label?: string }) {
    const run = await start(pocBasic, [body.label ?? 'poc-01']);
    return { runId: run.runId };
  }

  @Post('02-retry')
  async retry(@Body() body: { runKey: string; fatal?: boolean }) {
    const run = body.fatal
      ? await start(pocFatal, [body.runKey])
      : await start(pocRetry, [body.runKey]);
    return { runId: run.runId };
  }

  @Post('03-wait')
  async wait(@Body() body: { runKey: string; sleepFor?: string }) {
    const run = await start(pocWait, [body.runKey, body.sleepFor ?? '3s']);
    return { runId: run.runId };
  }

  @Post('05-side-effect')
  async sideEffect(@Body() body: { runKey: string; useIdempotencyKey?: boolean }) {
    const run = await start(pocSideEffect, [body.runKey, body.useIdempotencyKey !== false]);
    return { runId: run.runId };
  }

  @Post('06-idempotency')
  async idempotency(@Body() body: { triggerId: string }) {
    const run = await start(pocIdempotentTrigger, [body.triggerId]);
    return { runId: run.runId };
  }

  /** POC-07 / POC-08 / POC-09 / POC-10 all ride the dynamic interpreter. */
  @Post('07-dynamic')
  async dynamic(
    @Body()
    body: {
      runId: string;
      version: keyof typeof VERSIONS;
      employeeId?: string;
      trigger?: Record<string, unknown>;
    },
  ) {
    const definition = VERSIONS[body.version];
    if (!definition) return { error: `Unknown version ${String(body.version)}` };
    const run = await start(runOrlixaDefinition, [
      {
        runId: body.runId,
        companyId: 'company-poc',
        employeeId: body.employeeId ?? 'emp-authorized',
        workflowId: 'wf-marketing-launch',
        workflowVersionId: String(body.version),
        // The graph is passed as DATA — this is what pins the version to the run.
        definition,
        trigger: body.trigger ?? {},
      },
    ]);
    return { runId: run.runId, pinnedVersion: body.version };
  }

  @Get('run/:runId')
  async run(@Param('runId') runId: string, @Query('await') awaitResult?: string) {
    const handle = getRun(runId);
    const status = await handle.status;
    if (awaitResult !== '1' || status !== 'completed') {
      return { runId, status };
    }
    try {
      return { runId, status, returnValue: await handle.returnValue };
    } catch (error) {
      return { runId, status, error: String(error) };
    }
  }

  @Post('run/:runId/cancel')
  async cancel(@Param('runId') runId: string) {
    await getRun(runId).cancel();
    return { runId, cancelled: true };
  }

  // ── Orlixa-side surfaces ──────────────────────────────────────────────────

  @Get('approvals')
  approvals() {
    return listApprovals();
  }

  @Post('approvals/:id/decide')
  async decide(
    @Param('id') id: string,
    @Body() body: { approved: boolean; decidedBy?: string },
  ) {
    const decidedBy = body.decidedBy ?? 'manager@company-poc';
    const row = decideApproval(id, body.approved ? 'APPROVED' : 'REJECTED', decidedBy);
    // Orlixa decides; the SDK is only told to resume.
    const resumed = await resumeHook(row.hookToken, {
      approved: body.approved,
      decidedBy,
    });
    record('approval.resumed', { approvalId: id, sdkRunId: resumed.runId });
    return { approval: row, sdkRunId: resumed.runId };
  }

  @Get('provider')
  provider() {
    return providerState();
  }

  @Get('ledger')
  ledger(@Query('kind') kind?: string) {
    const all = readLedger();
    return kind ? all.filter((e) => e.kind === kind) : all;
  }

  @Post('provider/reset')
  reset() {
    resetProvider();
    return { reset: true };
  }
}
