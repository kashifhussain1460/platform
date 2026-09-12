'use client';

import { useState } from 'react';
import { Bot, Check, LayoutTemplate, Loader2, Wrench } from 'lucide-react';
import type { EmployeeRole, WorkflowCategory } from '@vaep/types';
import { useInstallWorkflowTemplate, useWorkflowTemplates } from '@/features/workflows/hooks';
import { useActiveEmployee } from '../../useActiveEmployee';
import { useOnboardingWizardStore } from '../../wizardStore';
import { EmployeeContextHeader } from '../EmployeeContextHeader';
import { FlowShell } from '../FlowShell';
import { StepFooter } from '../StepFooter';

/**
 * `WorkflowTemplateSummaryDto` (packages/types/src/index.ts) does NOT carry a
 * role-recommendation field — checked against the real DTO (id/companyId/key/
 * version/name/description/category/parameters/requires/status/createdAt)
 * before writing this filter. The only relevant field is `category:
 * WorkflowCategory`, so templates are filtered by mapping the active
 * employee's role onto a category instead of a `recommendedFor` field that
 * doesn't exist.
 *
 * `EmployeeRole` and `WorkflowCategory` share 5 of 8 string values verbatim
 * but diverge on the other 3 (RECRUITER -> RECRUITMENT, ACCOUNTANT ->
 * FINANCE, PROJECT_MANAGER -> OPERATIONS), so this is a real mapping table,
 * not a cast. The mapped category is passed straight into
 * `useWorkflowTemplates(category)`, which filters server-side
 * (`GET /workflow-templates?category=`) rather than fetching everything and
 * filtering in the browser.
 */
const ROLE_TO_WORKFLOW_CATEGORY: Record<EmployeeRole, WorkflowCategory> = {
  SUPPORT: 'SUPPORT',
  SALES: 'SALES',
  RECRUITER: 'RECRUITMENT',
  HR: 'HR',
  ACCOUNTANT: 'FINANCE',
  PROJECT_MANAGER: 'OPERATIONS',
  CUSTOM: 'CUSTOM',
  MARKETING: 'MARKETING',
};

/** Decorative-only per the plan: wiring the full AI-Assist chat / manual
 * builder into a wizard step is out of scope for this task. Left visible
 * (not removed) so the "3 build modes" affordance from the design isn't
 * silently dropped, but clearly inert. */
const INERT_BUILD_MODES = [
  { icon: Bot, label: 'Create with AI Assist', hint: 'Describe what you want in plain English — coming soon' },
  { icon: Wrench, label: 'Build manually', hint: 'Create from scratch — coming soon' },
] as const;

export function WorkflowsStep() {
  const goToStep = useOnboardingWizardStore((s) => s.goToStep);
  const { employee } = useActiveEmployee();

  // There is no field on `WorkflowDto` linking an installed workflow back to
  // the template that created it (provenance is recorded server-side per the
  // doc-19 comment on `WorkflowTemplateSummaryDto`, not exposed to clients),
  // so "already installed" can only be tracked for templates THIS screen
  // installed in the current session — not derived from a query. The
  // `idempotencyKey` below is what actually prevents a duplicate workflow if
  // the user reloads and clicks Install again; this state is purely a UI
  // convenience so a second click reads as "already installed" rather than
  // silently repeating an install call.
  const [installedIds, setInstalledIds] = useState<Set<string>>(new Set());
  const [pendingId, setPendingId] = useState<string | null>(null);
  // Visible failure feedback (Tasks 9-12's recurring lesson): the install
  // mutation has no optimistic update to roll back, but a failed install
  // (e.g. missing prerequisite skill/employee role, 409, network blip) must
  // still surface somewhere — a click that silently does nothing reads as
  // broken.
  const [actionError, setActionError] = useState<string | null>(null);
  // Templates can declare required parameters beyond the employee binding
  // (e.g. Sales's WhatsApp nurture-template Content SID) — a free-text value
  // this screen cannot derive automatically. Keyed by templateId, then by
  // param key; only holds values the user has actually typed. `param.default`
  // is applied as a read-time fallback (see `getExtraParamValue` below) so an
  // untouched field still displays and submits its declared default.
  const [extraParamValues, setExtraParamValues] = useState<Record<string, Record<string, string>>>({});

  const category = employee ? ROLE_TO_WORKFLOW_CATEGORY[employee.role] : undefined;
  const templatesQuery = useWorkflowTemplates(category);
  const templates = templatesQuery.data ?? [];
  const installTemplate = useInstallWorkflowTemplate();

  const backToHub = () => goToStep('configureEmployees');

  if (!employee) {
    return (
      <FlowShell heading="Workflows">
        <p className="text-sm text-fg-muted">No AI Employee selected yet.</p>
        <StepFooter onBack={backToHub} onContinue={backToHub} />
      </FlowShell>
    );
  }

  // Load gate (the recurring lesson from Tasks 9-12's reviews): don't render
  // install buttons before the template catalog has actually resolved. Before
  // that, `templates` is an empty placeholder — rendering the list as "no
  // templates for this role" would be a false negative, and if a click could
  // somehow fire early, `template.parameters` would be `[]`, silently
  // dropping the employee-id binding from the install call.
  if (!templatesQuery.isSuccess) {
    if (templatesQuery.isError) {
      return (
        <FlowShell heading="Workflows">
          <EmployeeContextHeader employee={employee} />
          <p className="text-sm text-red-400">
            Couldn't load workflow templates. {templatesQuery.error?.message ?? 'Please try again.'}
          </p>
          <StepFooter onBack={backToHub} onContinue={() => void templatesQuery.refetch()} continueLabel="Retry" />
        </FlowShell>
      );
    }
    return (
      <FlowShell heading="Workflows">
        <EmployeeContextHeader employee={employee} />
        <p className="text-sm text-fg-muted">Loading workflow templates…</p>
      </FlowShell>
    );
  }

  // Any parameter a template requires besides the employee binding (e.g.
  // Sales's `nurtureTemplateId`) — the wizard can't derive these, so the
  // user must type them before Install can fire.
  const getExtraRequiredParams = (template: (typeof templates)[number]) =>
    template.parameters.filter((p) => p.required && p.binds !== 'employee');

  // Effective value for one extra param: whatever the user typed, falling
  // back to the template's declared default (still needed even if the field
  // was never touched — that default must still reach the install call).
  const getExtraParamValue = (
    templateId: string,
    param: (typeof templates)[number]['parameters'][number],
  ) => extraParamValues[templateId]?.[param.key] ?? (param.default != null ? String(param.default) : '');

  const setExtraParamValue = (templateId: string, key: string, value: string) => {
    setExtraParamValues((prev) => ({
      ...prev,
      [templateId]: { ...prev[templateId], [key]: value },
    }));
  };

  const onInstall = (templateId: string) => {
    const template = templates.find((t) => t.id === templateId);
    if (!template) return;

    // Look up the parameter THIS template actually declares for binding an
    // employee id — never a hardcoded key name. First-party templates name it
    // differently per domain (e.g. `hrEmployee`, `salesEmployee`); `binds:
    // 'employee'` (TEMPLATE_PARAMETER_BINDS, doc 19 §6.3) is the only
    // reliable signal. A template with no such parameter (not every
    // workflow is employee-scoped) installs with no employee binding rather
    // than being blocked.
    const employeeParam = template.parameters.find((p) => p.binds === 'employee');
    const extraRequiredParams = getExtraRequiredParams(template);
    const parameters = {
      ...(employeeParam ? { [employeeParam.key]: employee.id } : {}),
      ...Object.fromEntries(extraRequiredParams.map((p) => [p.key, getExtraParamValue(templateId, p)])),
    };

    setActionError(null);
    setPendingId(templateId);
    installTemplate.mutate(
      {
        id: templateId,
        body: { parameters },
        idempotencyKey: `onboarding-${employee.id}-${templateId}`,
      },
      {
        onSuccess: () => {
          setPendingId(null);
          setInstalledIds((prev) => {
            const next = new Set(prev);
            next.add(templateId);
            return next;
          });
        },
        onError: (err) => {
          setPendingId(null);
          setActionError(err.message || `Couldn't install "${template.name}".`);
        },
      },
    );
  };

  return (
    <FlowShell
      heading={`Set Up Workflows for ${employee.name}`}
      subtitle="Choose how this employee will work."
      wide
    >
      <EmployeeContextHeader employee={employee} />

      {actionError && (
        <p className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
          {actionError}
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="flex flex-col items-start gap-2 rounded-xl border border-violet-secondary/50 bg-violet/[0.06] p-4">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-white/[0.06] text-violet-secondary">
            <LayoutTemplate className="h-4 w-4" />
          </span>
          <p className="text-sm font-medium text-white">Use a template</p>
          <p className="text-xs text-fg-muted">Start with a ready-made workflow below</p>
        </div>
        {INERT_BUILD_MODES.map(({ icon: Icon, label, hint }) => (
          <div
            key={label}
            className="flex cursor-not-allowed flex-col items-start gap-2 rounded-xl border border-white/[0.08] bg-white/[0.02] p-4 opacity-50"
          >
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-white/[0.06] text-violet-secondary">
              <Icon className="h-4 w-4" />
            </span>
            <p className="text-sm font-medium text-white">{label}</p>
            <p className="text-xs text-fg-muted">{hint}</p>
          </div>
        ))}
      </div>

      <p className="mb-2 mt-6 text-xs text-fg-muted">Recommended templates for {employee.role}</p>
      {templates.length === 0 ? (
        <p className="rounded-xl border border-dashed border-white/[0.1] px-4 py-6 text-center text-sm text-fg-muted">
          No templates available for this role yet — build one manually or with AI Assist (coming soon).
        </p>
      ) : (
        <ul className="space-y-2">
          {templates.map((tpl) => {
            const installed = installedIds.has(tpl.id);
            const pending = pendingId === tpl.id;
            const extraRequiredParams = getExtraRequiredParams(tpl);
            const missingExtraParam = extraRequiredParams.some(
              (p) => getExtraParamValue(tpl.id, p).trim() === '',
            );
            return (
              <li
                key={tpl.id}
                className={`flex flex-col gap-3 rounded-xl border px-4 py-3 transition-colors ${
                  installed ? 'border-violet-secondary/60 bg-violet/[0.08]' : 'border-white/[0.08] bg-white/[0.02]'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-white">{tpl.name}</span>
                    <span className="block text-xs text-fg-muted">{tpl.description}</span>
                  </span>
                  <button
                    type="button"
                    disabled={installed || pending || missingExtraParam}
                    onClick={() => onInstall(tpl.id)}
                    className={`flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                      installed
                        ? 'cursor-default bg-violet/20 text-violet-bright'
                        : 'border border-white/[0.1] text-zinc-300 hover:border-white/[0.2] hover:text-white disabled:cursor-default disabled:opacity-60'
                    }`}
                  >
                    {pending ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : installed ? (
                      <Check className="h-3.5 w-3.5" />
                    ) : null}
                    {installed ? 'Installed' : pending ? 'Installing…' : 'Install'}
                  </button>
                </div>
                {!installed && extraRequiredParams.length > 0 && (
                  <div className="grid gap-2 border-t border-white/[0.06] pt-3 sm:grid-cols-2">
                    {extraRequiredParams.map((p) => (
                      <label key={p.key} className="flex flex-col gap-1">
                        <span className="text-xs font-medium text-zinc-300">{p.label}</span>
                        <input
                          type="text"
                          value={getExtraParamValue(tpl.id, p)}
                          onChange={(e) => setExtraParamValue(tpl.id, p.key, e.target.value)}
                          placeholder={p.help}
                          disabled={pending}
                          className="rounded-lg border border-white/[0.1] bg-white/[0.02] px-2.5 py-1.5 text-xs text-white placeholder:text-fg-muted focus:border-violet-secondary/60 focus:outline-none disabled:opacity-60"
                        />
                      </label>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <StepFooter onBack={backToHub} onContinue={backToHub} continueLabel="Save & Back to Hub →" />
    </FlowShell>
  );
}
