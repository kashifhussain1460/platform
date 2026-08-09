# 27 — HR Employee · Production Workflow Specifications

**Date:** 2026-08-01 · **Employee:** HR (`EmployeeRole.HR` — **shipped**)
**Node identifiers:** frozen per `26-mvp-node-contract-freeze.md`. No node outside the 17 is used.
**Skills:** only the 14 real catalog entries. No invented connectors.

---

## 0. Read this before implementing

### 0.1 Buildability — verified against the live schema, not doc 12

Doc 12 proposes the HR data model; **it is not shipped**. Verified directly against
`apps/api/prisma/schema.prisma`:

| Model | Shipped? | Blocks |
|---|---|---|
| `InterviewSlot` | ✅ **yes** | — |
| `StaffMember` | ❌ no | HR-04…HR-11 (8 of 11 workflows) |
| `LeaveRequest` | ❌ no | HR-06 |
| `AttendanceRecord` | ❌ no | HR-07 |
| `PerformanceReview` | ❌ no | HR-08 |
| `OnboardingTask` | ❌ no | HR-04 |
| `StaffDocument` | ❌ no | HR-05, HR-09 |

**Only HR-01, HR-02 and HR-03 are buildable today.** The other eight need the doc-12 HR schema
migrated first. This is the honest sequencing constraint, and it is why §0.5 splits delivery into two
phases rather than pretending all eleven can ship together.

### 0.2 Skills actually available to HR

`gmail` (send_email, read_inbox) · `email` (send_email) · `calendar` (create_event) ·
`scheduling` (claim_slot, reschedule_slot) · `gdrive` (upload_file, list_files, read_file,
create_folder, move_file) · `slack` (send_message) · `plane` / `jira` (issue tracking for onboarding
tasks) · `http` (request).

**No ATS, no HRIS, no payroll, no background-check connector exists.** Any workflow needing one uses
`http.request` against a customer-configured endpoint, or is out of scope. Do not invent a connector.

### 0.3 Approval policy — the tiering that decides autonomy

The instruction *"do not make every workflow autonomous"* is implemented as a rule, not a vibe:

| Tier | Meaning | Approval | Examples |
|---|---|---|---|
| **T0** | Read-only or internal-reversible | none | screening scores, attendance rollups, record reads |
| **T1** | Writes an internal record | none, audit only | log attendance, update a task |
| **T2** | Leaves the company / affects a person's standing | **`APPROVAL` node required** | any candidate email, offer, rejection, review publication, exit |
| **T3** | Legal, financial or irreversible | **`APPROVAL` + named role** | termination, contract issuance, data deletion |

**A machine never tells a human they were rejected, hired, or terminated.** Every T2/T3 boundary in
this document is an `APPROVAL` node, not a config flag.

### 0.4 The two gotchas that will bite

1. **`NOTIFY` is not a real message.** It is a logger. Every actual notification below uses
   `TOOL_ACTION` with `gmail`/`slack`. `NOTIFY` is deliberately absent from the frozen 17.
2. **Only ONE Gmail-triggered workflow may be `ACTIVE` per connector.** HR-01 and HR-02 both want
   `TRIGGER(EVENT)` on inbound Gmail. Running both against one connector double-fires. Ship them as
   **one workflow with a `SWITCH`**, or scope each to a different connector (`triggerConfig.connectorId`).

### 0.5 Delivery phases

**Phase A (buildable now):** HR-01, HR-02, HR-03.
**Phase B (after the doc-12 HR migration):** HR-04 … HR-11.

### 0.6 Graph notation

`NODE_TYPE[id]` using frozen identifiers; `-->` main port; `--(port)-->` a named port.

---

## HR-01 · Recruitment Intake
**Tier:** T2 · **Template:** ✅ reusable (`hr.recruitment-intake`) · **Buildable now**

| Field | Value |
|---|---|
| **Trigger** | `TRIGGER(EVENT)` — inbound Gmail to the careers address; or `TRIGGER(MANUAL)` for bulk import |
| **Actors** | Candidate (external), Recruiter (human), HR Employee |
| **AI responsibility** | Parse the application, extract structured fields, deduplicate, acknowledge receipt. **Never decides suitability here** |
| **Skills** | `gmail.read_inbox`, `gdrive.upload_file`, `gmail.send_email` |
| **Knowledge** | Job descriptions, role requirements (category `HR`) |
| **Memory** | `MEMORY_READ` — prior applications from the same candidate |
| **Input** | `{ email, attachments[], jobRef? }` |
| **Conditions** | CV attachment present; duplicate within 90 days |
| **Human approvals** | Acknowledgement email is **auto-sent** (T2 exception: templated, factual, non-decisional). Anything evaluative is not sent here |
| **Output** | Candidate record + CV in Drive + acknowledgement sent |
| **Failure** | No CV → route to recruiter queue, do not reject |
| **Retry** | Gmail/Drive `EXPONENTIAL ×3`; parse failure is `VALIDATION_ERROR`, no retry |
| **Escalation** | 2 failed parses of the same message → Slack the recruiter |
| **Audit** | `full` — every candidate record creation |
| **KPIs** | Intake latency < 5 min; parse success ≥ 95%; duplicate-detection accuracy |
| **Security** | CVs contain PII. Drive folder tenant-scoped and access-restricted; never log CV content |

```
TRIGGER[t1] --> CONDITION[has_cv]
  has_cv --(false)--> TOOL_ACTION[slack_recruiter] --> TERMINATE[stop_nocv]
  has_cv --(true)--> AI_EMPLOYEE_STEP[extract]      # role=HR, structured extraction
    --> MEMORY_READ[prior_apps] --> CONDITION[is_dup]
      is_dup --(true)--> SET_VARIABLE[flag_dup] --> TOOL_ACTION[slack_recruiter]
      is_dup --(false)--> TOOL_ACTION[drive_upload]
        --> MEMORY_WRITE[save_candidate]
        --> TOOL_ACTION[ack_email]
        --> TERMINATE[done]
```

---

## HR-02 · Candidate Screening
**Tier:** T2 · **Template:** ✅ reusable (`hr.candidate-screening`) · **Buildable now**

| Field | Value |
|---|---|
| **Trigger** | `TRIGGER(EVENT)` from HR-01, or `TRIGGER(MANUAL)` on a shortlist |
| **Actors** | Recruiter (**decides**), HR Employee (recommends) |
| **AI responsibility** | Score against the job description with **written justification and citations**. Recommends only |
| **Skills** | `gdrive.read_file`, `gmail.send_email` (post-approval only) |
| **Knowledge** | `RETRIEVE` — job description, scoring rubric, past successful hires |
| **Memory** | Prior screening decisions for calibration |
| **Input** | `{ candidateId, jobRef }` |
| **Conditions** | `score ≥ threshold` → advance; `< threshold` → recommend reject |
| **Human approvals** | 🔴 **`APPROVAL` before ANY outcome reaches the candidate.** Rejections are never auto-sent |
| **Output** | Score, justification, citations, recommendation, recruiter decision |
| **Failure** | Unreadable CV → `SKIPPED` + manual-review flag |
| **Retry** | LLM `EXPONENTIAL ×3`; low confidence is not a retry — it escalates |
| **Escalation** | Confidence < 0.6 → mandatory human review regardless of score |
| **Audit** | `full` — score, model, prompt version, citations, decider. **Required for discrimination defence** |
| **KPIs** | Screening time; recruiter override rate (high = miscalibrated rubric); adverse-impact ratio by group |
| **Security** | **Bias is the primary risk.** Never expose age/gender/nationality/photo to the model. Prompt version recorded on every decision |

```
TRIGGER[t1] --> RETRIEVE[jd_rubric] --> AI_EMPLOYEE_STEP[score]
  --> CONDITION[confident]
    confident --(false)--> APPROVAL[manual_review] --(approved)--> SET_VARIABLE[decision]
    confident --(true)--> SWITCH[band]
      band --(strong)--> APPROVAL[advance]  --(approved)--> TOOL_ACTION[invite_email]
      band --(weak)-->   APPROVAL[reject]   --(approved)--> TOOL_ACTION[reject_email]
      band --(border)--> APPROVAL[manual_review]
  ... all paths --> MEMORY_WRITE[record_decision] --> TERMINATE[done]
```

Note both `APPROVAL` branches converge on `MEMORY_WRITE` — a rejected candidate is recorded just as
carefully as an advanced one, which is what makes the audit trail defensible.

---

## HR-03 · Interview Scheduling
**Tier:** T1 · **Template:** ✅ reusable (`hr.interview-scheduling`) · **Buildable now**

| Field | Value |
|---|---|
| **Trigger** | `TRIGGER(EVENT)` — candidate advanced by HR-02 |
| **Actors** | Candidate, Interviewer, HR Employee |
| **AI responsibility** | Claim a slot from the pool, create the calendar event, send details, handle reschedules |
| **Skills** | `scheduling.claim_slot`, `scheduling.reschedule_slot`, `calendar.create_event`, `gmail.send_email` |
| **Knowledge** | Interview process docs, panel composition rules |
| **Memory** | Candidate's timezone and prior reschedules |
| **Input** | `{ candidateId, stage, interviewerPool[] }` |
| **Conditions** | Slot available; candidate confirms within 48h |
| **Human approvals** | None — scheduling is reversible and the candidate already knows they advanced. **T1 by design** |
| **Output** | Booked `InterviewSlot`, calendar event with Meet link, confirmation email |
| **Failure** | No slot → notify recruiter, do not silently drop |
| **Retry** | `claim_slot` is **atomic**; on contention retry ×3 with jitter against a *different* slot |
| **Escalation** | No confirmation in 48h → `WAIT` expires → recruiter Slack |
| **Audit** | `metadata` |
| **KPIs** | Time-to-schedule; no-show rate; reschedule rate |
| **Security** | Meet links are sensitive — send only to the verified candidate address on record |

```
TRIGGER[t1] --> TOOL_ACTION[claim_slot]
  --> CONDITION[got_slot]
    got_slot --(false)--> TOOL_ACTION[slack_recruiter] --> TERMINATE[no_slot]
    got_slot --(true)--> TOOL_ACTION[create_event]
      --> TOOL_ACTION[email_candidate]
      --> WAIT[confirm_48h]
      --> CONDITION[confirmed]
        confirmed --(false)--> TOOL_ACTION[slack_recruiter]
        confirmed --(true)--> MEMORY_WRITE[log] --> TERMINATE[done]
```

`claim_slot` uses the shipped atomic claim — two workflows racing for the last slot cannot both win.

---

## HR-04 · Employee Onboarding
**Tier:** T2 · **Template:** ✅ reusable (`hr.onboarding`) · ⛔ **needs `StaffMember` + `OnboardingTask`**

| Field | Value |
|---|---|
| **Trigger** | `TRIGGER(EVENT)` — offer accepted; or `TRIGGER(MANUAL)` |
| **Actors** | New hire, Hiring manager, IT, HR Employee |
| **AI responsibility** | Generate the task checklist from role + department, assign owners, chase overdue items |
| **Skills** | `plane.create_issue` / `jira.create_issue`, `gdrive.create_folder`, `gmail.send_email`, `slack.send_message` |
| **Knowledge** | Onboarding policy, role-specific checklists, IT provisioning matrix |
| **Memory** | Prior onboarding bottlenecks per department |
| **Input** | `{ staffId, role, department, startDate, managerId }` |
| **Conditions** | Start date reached; each task complete |
| **Human approvals** | 🔴 **`APPROVAL` on the generated checklist before anything is sent** — a wrong checklist means wrong system access |
| **Output** | Task set, Drive folder, welcome email, manager brief |
| **Failure** | Task-system unavailable → `WAIT` + retry; never partially provision silently |
| **Retry** | `EXPONENTIAL ×3` per integration |
| **Escalation** | Task overdue > 2 days → manager; > 5 days → HR lead |
| **Audit** | `full` — access provisioning is a security event |
| **KPIs** | Day-1 readiness %; time-to-productive; overdue task count |
| **Security** | 🔴 Onboarding grants access. The checklist is an **access-control document** — approval is mandatory, never inferred |

```
TRIGGER[t1] --> RETRIEVE[policy] --> AI_EMPLOYEE_STEP[build_checklist]
  --> APPROVAL[hr_approves_checklist]
    --(rejected)--> TERMINATE[cancelled]
    --(approved)--> PARALLEL[fanout]
        --> TOOL_ACTION[create_tasks]
        --> TOOL_ACTION[create_drive_folder]
        --> TOOL_ACTION[welcome_email]
      JOIN[j1] --> WAIT[until_start_date]
        --> LOOP[chase_overdue]   # maxIterations bounded
            --(body)--> TOOL_ACTION[nudge_owner]
            --(done)--> MEMORY_WRITE[log] --> TERMINATE[done]
```

---

## HR-05 · Document Verification
**Tier:** T3 · **Template:** ⚠️ partial — jurisdiction-specific · ⛔ **needs `StaffDocument`**

| Field | Value |
|---|---|
| **Trigger** | `TRIGGER(EVENT)` — document uploaded |
| **Actors** | Employee, HR officer (**decides**), HR Employee |
| **AI responsibility** | Extract fields, check completeness and expiry, flag anomalies. **Never asserts a document is genuine** |
| **Skills** | `gdrive.read_file`, `gdrive.move_file`, `gmail.send_email` |
| **Knowledge** | Required-document matrix per country/role; retention policy |
| **Memory** | Which documents this employee has already provided |
| **Input** | `{ staffId, documentType, fileId }` |
| **Conditions** | Legible; not expired; matches the declared type |
| **Human approvals** | 🔴 **`APPROVAL` always.** Right-to-work is a legal determination a model must not make |
| **Output** | Verified/rejected status, extracted metadata, expiry reminder scheduled |
| **Failure** | Illegible → request re-upload, never reject outright |
| **Retry** | OCR ×2; then human |
| **Escalation** | Any anomaly → HR lead immediately |
| **Audit** | `full`, retained per policy — this is regulator-facing evidence |
| **KPIs** | Verification turnaround; re-upload rate; expiry-lapse count (target 0) |
| **Security** | 🔴 Passports/visas are special-category PII. Restricted Drive folder, encrypted, **never** in prompts sent to a third-party LLM without a DPA; redact from all logs |

```
TRIGGER[t1] --> TOOL_ACTION[read_doc] --> AI_EMPLOYEE_STEP[extract]
  --> CONDITION[legible]
    legible --(false)--> TOOL_ACTION[request_reupload] --> TERMINATE[pending]
    legible --(true)--> APPROVAL[officer_verifies]
      --(rejected)--> TOOL_ACTION[notify_employee] --> TERMINATE[rejected]
      --(approved)--> TOOL_ACTION[move_to_verified]
        --> SET_VARIABLE[expiry] --> MEMORY_WRITE[log] --> TERMINATE[done]
```

---

## HR-06 · Leave Management
**Tier:** T2 · **Template:** ✅ reusable (`hr.leave-request`) · ⛔ **needs `LeaveRequest`**

| Field | Value |
|---|---|
| **Trigger** | `TRIGGER(WEBHOOK)` from a leave form, or `TRIGGER(EVENT)` from email |
| **Actors** | Employee, Line manager (**decides**), HR Employee |
| **AI responsibility** | Validate balance, detect team-coverage clashes, route to the right approver, apply policy |
| **Skills** | `gmail.send_email`, `slack.send_message`, `calendar.create_event` |
| **Knowledge** | Leave policy, public holidays, notice-period rules |
| **Memory** | Employee's leave history and pattern |
| **Input** | `{ staffId, type, startDate, endDate, reason? }` |
| **Conditions** | Sufficient balance; notice period met; coverage available |
| **Human approvals** | 🔴 **`APPROVAL` by the line manager.** Auto-approval only for a policy-defined class (e.g. ≤1 day sick with balance) — configurable, off by default |
| **Output** | Decision, updated balance, calendar block, notifications |
| **Failure** | Balance unknown → escalate, never assume available |
| **Retry** | ×3 on notification failures |
| **Escalation** | No manager decision in 3 days → HR lead; ⚠️ **approval routing has no per-person targeting today** — route to the approver group and name the intended approver in the description |
| **Audit** | `full` — leave balance is a pay-affecting record |
| **KPIs** | Decision turnaround; auto-approval accuracy; balance-dispute count |
| **Security** | Sick-leave reasons are health data — store minimally, never in Slack |

```
TRIGGER[t1] --> AI_EMPLOYEE_STEP[parse_request] --> RETRIEVE[leave_policy]
  --> CONDITION[balance_ok]
    balance_ok --(false)--> TOOL_ACTION[notify_insufficient] --> TERMINATE[rejected]
    balance_ok --(true)--> CONDITION[auto_approvable]
      auto_approvable --(true)--> SET_VARIABLE[approved]
      auto_approvable --(false)--> APPROVAL[manager_decides]
        --(rejected)--> TOOL_ACTION[notify_rejected] --> TERMINATE[rejected]
        --(approved)--> SET_VARIABLE[approved]
  --> TOOL_ACTION[calendar_block] --> TOOL_ACTION[notify_team]
  --> MEMORY_WRITE[log] --> TERMINATE[done]
```

---

## HR-07 · Attendance Monitoring
**Tier:** T1 · **Template:** ✅ reusable (`hr.attendance-monitor`) · ⛔ **needs `AttendanceRecord`**

| Field | Value |
|---|---|
| **Trigger** | `TRIGGER(SCHEDULE)` — daily |
| **Actors** | HR Employee, Line managers |
| **AI responsibility** | Aggregate, detect anomaly patterns, summarise. **Never issues a warning** |
| **Skills** | `http.request` (customer attendance source), `slack.send_message` |
| **Knowledge** | Working-hours policy, shift patterns |
| **Memory** | Baseline per employee/team |
| **Input** | `{ date, scope }` |
| **Conditions** | Anomaly threshold exceeded |
| **Human approvals** | None for the report. 🔴 **Any disciplinary action is a separate T3 workflow with approval** |
| **Output** | Daily summary, flagged anomalies to managers |
| **Failure** | Source unavailable → skip the day, alert ops, never infer absence |
| **Retry** | ×3 then skip |
| **Escalation** | 3 consecutive source failures → ops |
| **Audit** | `metadata` |
| **KPIs** | Data completeness; false-positive rate on flags |
| **Security** | 🔴 **Surveillance risk.** Aggregate reporting only; no per-minute tracking; must satisfy works-council/GDPR constraints in EU tenants |

```
TRIGGER[t1] --> TOOL_ACTION[fetch_attendance]
  --> CONDITION[data_ok]
    data_ok --(false)--> TOOL_ACTION[alert_ops] --> TERMINATE[skipped]
    data_ok --(true)--> TRANSFORM[aggregate] --> AI_EMPLOYEE_STEP[detect_anomalies]
      --> CONDITION[has_anomaly]
        has_anomaly --(true)--> TOOL_ACTION[notify_managers]
        has_anomaly --(false)--> NOOP[n1]
      --> MEMORY_WRITE[baseline] --> TERMINATE[done]
```

---

## HR-08 · Performance Review
**Tier:** T3 · **Template:** ⚠️ partial — cycle-specific · ⛔ **needs `PerformanceReview`**

| Field | Value |
|---|---|
| **Trigger** | `TRIGGER(SCHEDULE)` — review cycle |
| **Actors** | Employee, Manager (**author**), HR Employee (**assists only**) |
| **AI responsibility** | Assemble evidence, draft a **structured summary for the manager to edit**. Never scores a person |
| **Skills** | `gdrive.read_file`, `plane.list_issues`/`jira.list_issues`, `gmail.send_email` |
| **Knowledge** | Competency framework, review templates, goal definitions |
| **Memory** | Prior reviews and goals |
| **Input** | `{ staffId, cycleId }` |
| **Conditions** | Sufficient evidence available |
| **Human approvals** | 🔴 **`APPROVAL` by the manager on the draft, and a second `APPROVAL` before it reaches the employee** |
| **Output** | Evidence pack, manager-edited review, employee acknowledgement |
| **Failure** | Thin evidence → say so explicitly rather than inventing |
| **Retry** | ×2 on data gathering |
| **Escalation** | Manager not submitted in 14 days → HR lead |
| **Audit** | `full` — reviews affect pay and promotion; the AI draft **and** the human edits are both retained |
| **KPIs** | Cycle completion rate; edit distance between draft and final (high = draft not useful); calibration spread |
| **Security** | 🔴 **Never let the model assign a rating.** It assembles evidence; humans judge. Watch for bias in language — run tone analysis on drafts |

```
TRIGGER[t1] --> PARALLEL[gather]
    --> TOOL_ACTION[fetch_goals]
    --> TOOL_ACTION[fetch_tickets]
    --> MEMORY_READ[prior_reviews]
  JOIN[j1] --> CONDITION[enough_evidence]
    enough_evidence --(false)--> SET_VARIABLE[flag_thin]
    enough_evidence --(true)--> NOOP[n1]
  --> AI_EMPLOYEE_STEP[draft_summary]
  --> APPROVAL[manager_edits]
    --(rejected)--> TERMINATE[abandoned]
    --(approved)--> APPROVAL[hr_release_to_employee]
      --(approved)--> TOOL_ACTION[send_to_employee]
        --> MEMORY_WRITE[log] --> TERMINATE[done]
```

Two sequential approvals is deliberate: the manager owns the content, HR owns the release.

---

## HR-09 · Employee Record Management
**Tier:** T2/T3 · **Template:** ✅ reusable (`hr.record-update`) · ⛔ **needs `StaffMember` + `StaffDocument`**

| Field | Value |
|---|---|
| **Trigger** | `TRIGGER(WEBHOOK)` (self-service change) or `TRIGGER(MANUAL)` |
| **Actors** | Employee, HR officer, HR Employee |
| **AI responsibility** | Validate the change, classify sensitivity, route accordingly |
| **Skills** | `gdrive.*`, `gmail.send_email` |
| **Knowledge** | Data-retention policy, which fields are self-serviceable |
| **Memory** | Change history |
| **Input** | `{ staffId, field, oldValue, newValue }` |
| **Conditions** | Field class: self-service / HR-approved / restricted |
| **Human approvals** | 🔴 Salary, job title, bank details, employment status → **`APPROVAL`**. Address/phone → auto with notification |
| **Output** | Updated record, change log, confirmation |
| **Failure** | Validation failure → reject with reason |
| **Retry** | ×2 |
| **Escalation** | Bank-detail change → **always** HR + a fraud check (classic payroll-diversion attack) |
| **Audit** | `full`, immutable, old + new value |
| **Security** | 🔴 Bank-detail changes are the #1 HR fraud vector. Require approval **and** out-of-band verification, never email-only confirmation |

```
TRIGGER[t1] --> AI_EMPLOYEE_STEP[classify_change]
  --> SWITCH[sensitivity]
    --(self_service)--> SET_VARIABLE[apply] --> TOOL_ACTION[notify_employee]
    --(hr_approved)--> APPROVAL[hr_officer] --(approved)--> SET_VARIABLE[apply]
    --(restricted)--> APPROVAL[hr_lead] --(approved)--> TOOL_ACTION[oob_verify]
        --> APPROVAL[confirm_after_verify] --(approved)--> SET_VARIABLE[apply]
  --> MEMORY_WRITE[change_log] --> TERMINATE[done]
```

---

## HR-10 · Compliance Monitoring
**Tier:** T2 · **Template:** ⚠️ partial — jurisdiction-specific · ⛔ **needs `StaffMember` + `StaffDocument`**

| Field | Value |
|---|---|
| **Trigger** | `TRIGGER(SCHEDULE)` — weekly |
| **Actors** | HR lead, Compliance officer, HR Employee |
| **AI responsibility** | Detect expiring documents, missing mandatory training, policy-acknowledgement gaps |
| **Skills** | `gdrive.list_files`, `gmail.send_email`, `slack.send_message` |
| **Knowledge** | Compliance matrix per jurisdiction, training requirements |
| **Memory** | Prior findings and closures |
| **Input** | `{ scope, asOfDate }` |
| **Conditions** | Expiry within 30/60/90 days; overdue |
| **Human approvals** | Reminders auto-send (factual, non-decisional). 🔴 **Any escalation naming an individual as non-compliant → `APPROVAL`** |
| **Output** | Compliance dashboard, reminders, escalation report |
| **Failure** | Incomplete data → report the gap as a finding, never as compliant |
| **Retry** | ×3 |
| **Escalation** | Any item overdue > 30 days → compliance officer |
| **Audit** | `full`, long retention — this is regulator evidence |
| **KPIs** | Compliance rate; mean time to remediate; overdue count |
| **Security** | Findings name individuals — restrict distribution; **never** post to a general Slack channel |

```
TRIGGER[t1] --> TOOL_ACTION[scan_documents] --> RETRIEVE[compliance_matrix]
  --> AI_EMPLOYEE_STEP[find_gaps]
  --> LOOP[per_finding]
      --(body)--> SWITCH[severity]
          --(reminder)--> TOOL_ACTION[email_employee]
          --(escalate)--> APPROVAL[hr_lead_review]
              --(approved)--> TOOL_ACTION[escalation_report]
      --(done)--> MEMORY_WRITE[findings] --> TERMINATE[done]
```

---

## HR-11 · Employee Exit / Offboarding
**Tier:** T3 · **Template:** ✅ reusable (`hr.offboarding`) · ⛔ **needs `StaffMember` + `OnboardingTask`**

| Field | Value |
|---|---|
| **Trigger** | `TRIGGER(MANUAL)` — **deliberately never automatic** |
| **Actors** | Employee, Manager, IT, HR lead (**authorises**), HR Employee |
| **AI responsibility** | Generate the offboarding checklist, sequence access revocation, track asset return |
| **Skills** | `plane.create_issue`/`jira.create_issue`, `gdrive.move_file`, `gmail.send_email`, `slack.send_message` |
| **Knowledge** | Offboarding policy, notice periods, asset register, retention rules |
| **Memory** | Employee's access footprint and assets |
| **Input** | `{ staffId, exitType, lastWorkingDay }` |
| **Conditions** | Voluntary vs involuntary; notice period |
| **Human approvals** | 🔴 **`APPROVAL` by HR lead to start.** 🔴 Second `APPROVAL` before access revocation if the last working day has not passed |
| **Output** | Checklist, revocation schedule, final documents, archived records |
| **Failure** | Partial revocation is a **security incident** — alert immediately, never leave it half-done |
| **Retry** | ×3 per system, then page |
| **Escalation** | Any revocation failure → security team within 1h |
| **Audit** | `full` — who authorised, what was revoked, when, confirmed by whom |
| **KPIs** | Time to full revocation (target < 4h post-exit); asset recovery rate; incomplete-offboarding count (target 0) |
| **Security** | 🔴 **Highest-risk HR workflow.** Revoking too early strands an active employee; too late leaves a live account. Both are incidents. Involuntary exits may need *immediate* revocation **before** notification — that ordering is a human decision, never the model's |

```
TRIGGER[t1] --> APPROVAL[hr_lead_authorises]
  --(rejected)--> TERMINATE[cancelled]
  --(approved)--> AI_EMPLOYEE_STEP[build_exit_checklist]
    --> SWITCH[exit_type]
      --(involuntary)--> APPROVAL[immediate_revoke_decision]
      --(voluntary)-->   WAIT[until_last_day]
    --> PARALLEL[execute]
        --> TOOL_ACTION[revoke_access]
        --> TOOL_ACTION[asset_return_tasks]
        --> TOOL_ACTION[archive_records]
      JOIN[j1] --> CONDITION[all_confirmed]
        all_confirmed --(false)--> TOOL_ACTION[alert_security] --> TERMINATE[incident]
        all_confirmed --(true)--> MEMORY_WRITE[log] --> TERMINATE[done]
```

---

## Summary

| # | Workflow | Tier | Approvals | Template | Buildable now |
|---|---|---|---|---|---|
| HR-01 | Recruitment Intake | T2 | 0 (ack only) | ✅ | ✅ |
| HR-02 | Candidate Screening | T2 | **1–2** | ✅ | ✅ |
| HR-03 | Interview Scheduling | T1 | 0 | ✅ | ✅ |
| HR-04 | Onboarding | T2 | **1** | ✅ | ⛔ |
| HR-05 | Document Verification | T3 | **1** | ⚠️ | ⛔ |
| HR-06 | Leave Management | T2 | **1** | ✅ | ⛔ |
| HR-07 | Attendance Monitoring | T1 | 0 | ✅ | ⛔ |
| HR-08 | Performance Review | T3 | **2** | ⚠️ | ⛔ |
| HR-09 | Record Management | T2/T3 | **1–2** | ✅ | ⛔ |
| HR-10 | Compliance | T2 | **1** | ⚠️ | ⛔ |
| HR-11 | Offboarding | T3 | **2** | ✅ | ⛔ |

**8 of 11 have at least one mandatory human approval.** The three that don't are read-only or
reversible. Nothing that affects a person's employment, pay or standing happens without a named human.

**Templates:** 8 fully reusable, 3 partial (jurisdiction- or cycle-specific — parameterising them
across legal regimes would produce a template nobody can safely use).

---

**Next:** `28-marketing-employee-workflows.md`.
