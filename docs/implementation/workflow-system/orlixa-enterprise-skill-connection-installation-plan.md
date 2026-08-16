# Orlixa Enterprise Skill Connection & Installation Plan

**File:** `orlixa-enterprise-skill-connection-installation-plan.md`  
**Status:** Final Architecture / Implementation Specification  
**Scope:** Enterprise SaaS skill installation, authentication, connection, validation, health, assignment and execution

## 1. Executive Decision

Orlixa must NOT treat every skill as:

```text
Install → API Key → Save
```

Different integrations require different authentication, permission, account, inbound, outbound, and approval models.

The universal experience is:

```text
Skill Catalog
↓
Install / Connect
↓
Provider Selection
↓
Authentication / Credentials
↓
Permission / Scope Selection
↓
Account / Workspace Discovery
↓
Connection Validation
↓
Test Action
↓
Inbound Setup (if applicable)
↓
Health Check
↓
Assign to AI Employee
↓
Save + Audit
↓
READY
```

The frontend provides one consistent experience. Provider-specific complexity remains inside backend adapters.

## 2. Core Architecture

```text
Skill Catalog
↓
InstalledSkill
↓
Connection
├── Authentication
├── Permissions / Scopes
├── Account / Project / Folder
└── Health
↓
AI Employee Assignment
↓
SkillExecutor
↓
Authorization / Approval
↓
Provider Adapter
↓
External Provider
↓
Audit
```

### Core principle

- Skill Catalog = what Orlixa can do.
- Connection = which real external account is authorized.
- SkillExecutor = execution boundary.
- Provider Adapter = provider-specific implementation.
- Authorization, approval, tenant isolation, audit and idempotency remain Orlixa-owned.

## 3. Universal Installation State Machine

```text
NOT_INSTALLED
↓
SELECT_PROVIDER
↓
AUTHENTICATING
↓
AUTHENTICATED
↓
VALIDATING_SCOPE
↓
DISCOVERING_ACCOUNT
↓
VALIDATING_CONNECTION
↓
TESTING
↓
CONFIGURING_INBOUND
↓
HEALTH_CHECK
↓
ASSIGNING
↓
READY
```

Failure states:

```text
AUTH_FAILED
INVALID_CREDENTIALS
INSUFFICIENT_SCOPE
ACCOUNT_NOT_FOUND
CONNECTION_FAILED
TEST_FAILED
WEBHOOK_FAILED
HEALTH_CHECK_FAILED
EXPIRED
REVOKED
DEGRADED
ERROR
```

A connection cannot become `READY` until all required stages pass.

## 4. Credential Security

Credentials must never be:

- returned to frontend
- exposed to AI prompts
- logged
- stored in plaintext
- included in workflow definitions
- included in audit payloads
- exposed through normal API responses

Required flow:

```text
User
↓
Connection Wizard
↓
Secure Backend
↓
Validate
↓
Encrypt
↓
Persist
↓
Provider Adapter
```

Frontend receives only redacted metadata:

```json
{
  "provider": "GMAIL",
  "status": "READY",
  "account": "hr@example.com",
  "credentialConfigured": true
}
```

## 5. Skill Catalog vs Connection

```text
Skill
≠
Connection
```

Example:

```text
Skill: Gmail
Connection: hr@company.com
```

Multiple connections may exist for the same skill.

## 6. Employee Assignment

Use least privilege:

```text
Company
↓
Skill Connection
↓
Permission / Scope
↓
AI Employee
```

Example:

```text
HR AI → hr@company.com
Sales AI → sales@company.com
Support AI → support@company.com
```

Do not expose every company connection to every AI Employee.

# 7. Email Skill

## Purpose

Transactional outbound email.

Possible providers:

- Resend
- SendGrid
- Mailgun
- Postmark
- Custom SMTP

Flow:

```text
Install Email
↓
Choose Provider
↓
Authentication
↓
Verify Sender / Domain where required
↓
Configure Outbound
↓
Test Send
↓
Health Check
↓
Assign AI Employee
↓
READY
```

### Custom SMTP

Fields:

```text
Email Address
SMTP Host
SMTP Port
Security
Username
Password
From Address
```

Credentials are encrypted.

An address such as `employee@company.com` does not prove whether the provider is Google Workspace, Microsoft 365, a custom mail server, or a transactional provider.

## 8. Gmail Skill

Gmail is a mailbox integration.

Capabilities:

```text
send_email
read_inbox
thread/read
```

Flow:

```text
Install Gmail
↓
Continue with Google
↓
OAuth
↓
Google Consent
↓
Callback
↓
Resolve Gmail Account
↓
Validate Scopes
↓
Test Send
↓
Test Inbox
↓
Configure Inbound
↓
Health Check
↓
Assign Employee
↓
READY
```

Example:

```text
hr@company.com → HR AI
support@company.com → Support AI
```

### Gmail inbound

```text
Gmail
↓
Gmail Adapter
↓
Inbound Event
↓
Provider Validation
↓
Deduplication
↓
Canonical Event
↓
Trigger Matching
↓
WorkflowRun
↓
Durable Runtime
```

## 9. Microsoft 365 / Outlook

```text
Install Microsoft Mail
↓
Continue with Microsoft
↓
OAuth
↓
Tenant / Account Consent
↓
Resolve Mailbox
↓
Validate Permissions
↓
Test Send
↓
Test Read
↓
Configure Inbound
↓
Health Check
↓
Assign Employee
↓
READY
```

## 10. Custom Company Email

```text
Custom Email Server
↓
SMTP Configuration
↓
IMAP Configuration
↓
Credential Validation
↓
SMTP Connection Test
↓
IMAP Connection Test
↓
Mailbox Identity Check
↓
Send Test Email
↓
Receive Test Email
↓
Health Check
↓
Encrypt + Persist
↓
READY
```

Fields:

```text
SMTP Host
SMTP Port
SMTP Security
SMTP Username
SMTP Password

IMAP Host
IMAP Port
IMAP Security
IMAP Username
IMAP Password

From Address
```

## 11. Company Domain Email

Connecting an existing mailbox and configuring a company domain are separate capabilities.

### Existing mailbox

```text
Connect
↓
Authenticate
↓
Validate
↓
READY
```

### Domain infrastructure

```text
Company Domain
↓
Domain Verification
↓
SPF
↓
DKIM
↓
DMARC
↓
Inbound Routing where applicable
↓
Outbound Verification
↓
DOMAIN READY
```

Do not mix domain setup into basic mailbox connection.

# 12. Slack

```text
Install Slack
↓
Continue with Slack
↓
OAuth
↓
Workspace Selection
↓
Scope Validation
↓
Discover Channels
↓
Select Allowed Channels
↓
Test Message
↓
Health Check
↓
Assign Employee
↓
READY
```

Prefer:

```text
Company
↓
Slack Connection
↓
Allowed Channels
↓
AI Employee
```

Do not automatically expose the entire workspace.

# 13. Stripe

Stripe is high-risk.

```text
Install Stripe
↓
Choose Test / Production
↓
Connect Account
↓
Authenticate
↓
Validate Account
↓
Validate Permissions
↓
Select Capabilities
↓
Test Read Operation
↓
Health Check
↓
Assign Employee
↓
READY
```

Capabilities:

```text
Read Balance
Read Charges
Create Payment Link
Refund
Payout
```

Risk:

```text
Read Balance → Low
Read Charges → Low/Medium
Create Payment → High
Refund → High
Payout → Critical
```

High-risk actions require Orlixa authorization and approval.

# 14. GitHub

```text
Install GitHub
↓
OAuth / GitHub App
↓
Organization Selection
↓
Repository Selection
↓
Permission Validation
↓
Test Repository Read
↓
Test Issue Action if Granted
↓
Health Check
↓
Assign Employee
↓
READY
```

Scope:

```text
Organization
↓
Repository
↓
AI Employee
```

# 15. HTTP

HTTP is a high-risk generic skill.

```text
Install HTTP
↓
Security Configuration
↓
Allowed Domains
↓
Authentication
↓
SSRF Validation
↓
Request Validation
↓
Test Request
↓
Health Check
↓
Assign Employee
↓
READY
```

Auth:

```text
None
API Key
Bearer
Custom Header
```

Required security:

```text
Private IP blocking
localhost blocking
Cloud metadata endpoint blocking
DNS rebinding protection
Timeout
Response size limits
Redirect validation
HTTPS policy where required
```

Never allow arbitrary internal-network access.

# 16. HubSpot

```text
Install HubSpot
↓
Continue with HubSpot
↓
OAuth
↓
Select HubSpot Account
↓
Scope Validation
↓
Discover CRM Capabilities
↓
Test Contact Read
↓
Test Create/Update if Granted
↓
Health Check
↓
Assign Sales/CRM AI
↓
READY
```

Capabilities:

```text
Read Contacts
Create Contact
Update Contact
Read Deals
Update Deal
```

# 17. Jira

```text
Install Jira
↓
Select Supported Jira Instance
↓
OAuth / Supported Credential
↓
Select Site
↓
Select Projects
↓
Scope Validation
↓
Test Issue Read
↓
Test Issue Create if Granted
↓
Health Check
↓
Assign Project AI
↓
READY
```

Scope:

```text
Jira Site
↓
Project
↓
Issue
↓
AI Employee
```

# 18. Calendar

Support Google Calendar and Microsoft Calendar.

```text
Install Calendar
↓
Choose Provider
↓
OAuth
↓
Account Discovery
↓
Calendar Selection
↓
Permission Validation
↓
Test Create Event
↓
Timezone Validation
↓
Health Check
↓
Assign Employee
↓
READY
```

Track:

```text
accountId
calendarId
timezone
working hours
```

# 19. Google Drive

```text
Install Google Drive
↓
Continue with Google
↓
OAuth
↓
Scope Validation
↓
Select Drive / Folders
↓
Test List Files
↓
Test Read File
↓
Optional Write Test
↓
Health Check
↓
Assign Employee
↓
READY
```

Example:

```text
HR AI → HR Folder
```

not the entire company Drive.

# 20. Interview Scheduling

This is an Orlixa business capability.

```text
Install
↓
Configure Scheduling Policy
↓
Connect Calendar
↓
Select Interview Types
↓
Configure Duration
↓
Configure Buffer
↓
Configure Working Hours
↓
Configure Timezone
↓
Configure Interviewer Pool
↓
Configure Approval Rules
↓
Test Slot
↓
Health Check
↓
Assign Recruiter AI
↓
READY
```

# 21. AI Marketing Manager — Postiz

Postiz follows a two-level model:

```text
Company
↓
Postiz Engine
↓
Social Account
↓
AI Marketing Manager
```

Flow:

```text
Install Postiz
↓
Verify Postiz Engine
↓
Connect Social Account
↓
OAuth
↓
Account Discovery
↓
Scope Validation
↓
Test Account
↓
Configure Publishing Policy
↓
Health Check
↓
Assign Marketing AI
↓
READY
```

Publishing:

```text
AI creates content
↓
Approval
↓
Postiz
↓
Publish
↓
Reconciliation
↓
Audit
```

# 22. AI Customer Support Manager — Chatwoot

Chatwoot is a company-level/self-hosted engine.

```text
Install Chatwoot
↓
Configure Instance
↓
Base URL
↓
Authentication/API Credential
↓
Validate Instance
↓
Select Account
↓
Validate Inboxes
↓
Configure Webhook
↓
Verify Webhook Signature
↓
Test Conversation
↓
Health Check
↓
Assign Support AI
↓
READY
```

Inbound:

```text
Chatwoot
↓
Webhook
↓
Signature Verification
↓
Deduplication
↓
Canonical Event
↓
Workflow
```

Verify before mutation.

# 23. AI Project Manager — Plane

Plane is a company-level/self-hosted engine.

```text
Install Plane
↓
Configure Plane Instance
↓
Base URL
↓
Connect / Provision Workspace
↓
API Credential
↓
Validate Workspace
↓
Select Projects
↓
Test List Issues
↓
Configure Webhook
↓
Verify Webhook Signature
↓
Health Check
↓
Assign Project AI
↓
READY
```

Do not fabricate workspace/token provisioning. Verify actual runtime behavior before `READY`.

Inbound:

```text
Plane
↓
Signature Verification
↓
Deduplication
↓
Canonical Event
↓
Workflow
```

# 24. Skill Classification

| Skill | Authentication | Scope | Inbound | Risk |
|---|---|---|---|---|
| Slack | OAuth | Workspace/Channel/Employee | Yes | Medium |
| Email | API Key / SMTP | Company/Employee | Optional | Medium |
| Gmail | OAuth | Mailbox/Employee | Yes | High |
| Stripe | OAuth/API credential | Company | Optional | Critical |
| GitHub | OAuth/App | Org/Repo | Yes | High |
| HTTP | API Key/Bearer/Custom | Domain/Employee | No | Critical |
| HubSpot | OAuth | Account/CRM | Yes | High |
| Jira | OAuth/Credential | Site/Project | Yes | High |
| Calendar | OAuth | Calendar/Employee | Yes | Medium |
| Google Drive | OAuth | Drive/Folder | Yes | High |
| Interview Scheduling | Orlixa + Calendar | Company/Employee | Yes | Medium |
| Postiz | Engine + Social OAuth | Company/Social Account | Yes | High |
| Chatwoot | Engine Credential | Company/Inbox | Yes | High |
| Plane | Engine Credential | Company/Workspace/Project | Yes | High |

# 25. Universal UI

Use connection states:

```text
AVAILABLE
CONNECTING
ACTION_REQUIRED
READY
DEGRADED
EXPIRED
REVOKED
ERROR
```

Buttons:

```text
AVAILABLE → Connect
CONNECTING → Connecting...
ACTION_REQUIRED → Continue setup
READY → Manage
DEGRADED → Fix connection
EXPIRED → Reconnect
REVOKED → Reconnect
ERROR → Retry
```

The catalog should not force every integration into a generic `Install → API Key` experience.

# 26. Universal Connection Wizard

```text
┌────────────────────────────────────┐
│ Connect Gmail                      │
│                                    │
│ 1. Provider        ✓               │
│ 2. Authentication ○               │
│ 3. Permissions    ○               │
│ 4. Account         ○               │
│ 5. Test            ○               │
│ 6. Complete        ○               │
│                                    │
│ [Continue with Google]             │
└────────────────────────────────────┘
```

The user completes required steps sequentially.

# 27. Backend Connection Contract

Conceptual model:

```text
InstalledSkill
├── companyId
├── employeeId?
├── skillKey
├── provider
├── connectionType
├── displayName
├── scopes
├── status
├── healthStatus
├── lastHealthCheck
├── lastRefresh
├── metadata
└── encryptedCredentials
```

Credentials must never be stored in:

```text
WorkflowDefinition
AI prompt
Workflow input
Audit payload
Frontend state
Logs
```

# 28. Provider Adapter Contract

Each provider should conceptually implement:

```text
authenticate()
validateCredentials()
validateScopes()
discoverAccount()
validateConnection()
test()
configureInbound()
healthCheck()
execute()
classifyError()
reconcile()
disconnect()
```

Provider-specific behavior belongs inside the adapter.

Orlixa owns:

```text
Authorization
Approval
Tenant Isolation
Audit
Idempotency
Workflow Runtime
Entitlements
Observability
```

# 29. Execution Architecture

```text
Workflow
↓
WorkflowRun
↓
WorkflowStepAttempt
↓
SkillExecutor
↓
Validate Input
↓
Authorize
↓
Resolve Connection
↓
Check Approval
↓
Provider Adapter
↓
External Provider
↓
Classify Result
↓
Reconcile if necessary
↓
Audit
↓
Next Step
```

Never allow:

```text
AI
↓
Provider API
```

without the Orlixa execution boundary.

# 30. External Side-Effect Safety

If:

```text
External Action
↓
Provider SUCCESS
↓
Worker Crash
↓
Bookkeeping not persisted
```

do not blindly retry.

Classify:

```text
SUCCESS
RETRYABLE_FAILURE
NON_RETRYABLE_FAILURE
TIMEOUT
RATE_LIMIT
OUTCOME_UNKNOWN
```

If outcome is unknown:

```text
OUTCOME_UNKNOWN
↓
Reconciliation / manual recovery
```

not blind retry.

# 31. Inbound Event Architecture

```text
Provider
↓
Raw Event
↓
Signature Verification
↓
Tenant Resolution
↓
Deduplication
↓
Canonical Event
↓
Trigger Matching
↓
WorkflowRun
↓
Durable Runtime
```

No provider should create a parallel workflow execution path.

# 32. Audit

Audit:

```text
Connection Created
Connection Updated
Connection Reauthorized
Connection Revoked
Connection Failed
Scope Changed
Skill Assigned
Skill Unassigned
Health Check
External Action
Approval
Authorization Decision
Webhook
Workflow Run
Provider Failure
```

Audit should answer:

```text
WHO
WHAT
WHEN
WHERE
WHY
RESOURCE
WORKFLOW
RUN
PROVIDER
EXTERNAL REQUEST ID
RESULT
```

Never store raw credentials in audit.

# 33. Health Check

Every connection should expose:

```text
Connection Status
Credential Status
Permission Status
Provider Status
Inbound Status
Outbound Status
Last Successful Check
Last Failure
```

Example:

```text
READY
├── Authentication ✓
├── Permissions ✓
├── Account ✓
├── Outbound ✓
├── Inbound ✓
└── Health ✓
```

# 34. Disconnect / Reconnect

Disconnect:

```text
Revoke where supported
↓
Disable connection
↓
Stop new executions
↓
Handle pending inbound processing
↓
Remove encrypted credentials
↓
Audit
```

Reconnect creates a controlled new authentication flow.

Existing workflow runs must not silently change provider identity.

# 35. High-Risk Skills

Examples:

```text
Stripe Refund
Stripe Payout
HTTP arbitrary request
GitHub destructive action
Jira destructive action
HR sensitive data operation
Social publish
Customer reply
Plane mutation
```

Require as applicable:

```text
Authentication
+
Authorization
+
Skill Grant
+
Approval
+
Idempotency
+
Audit
+
Observability
```

# 36. Implementation Waves

## Wave 1 — Foundation

```text
Skill Catalog
InstalledSkill
Connection
Encrypted Credentials
OAuth State
API Key Storage
Connection Status
Health Status
Audit
Employee Assignment
```

## Wave 2 — Core Productivity

```text
Gmail
Slack
Calendar
Google Drive
```

## Wave 3 — Business SaaS

```text
GitHub
HubSpot
Jira
Stripe
```

## Wave 4 — Generic / Specialized

```text
HTTP
Email
Interview Scheduling
```

## Wave 5 — Engine Integrations

```text
Postiz
Chatwoot
Plane
```

Do not expand the engine roadmap while these integrations are being hardened.

# 37. Definition of Done

A skill is NOT complete because the Install button works.

It is complete only when:

- provider authentication works
- credentials are securely persisted
- scopes are validated
- account/workspace is discovered
- connection is tested
- inbound works where applicable
- outbound works where applicable
- health check works
- employee assignment works
- authorization works
- audit exists
- errors are classified
- retry behavior is defined
- idempotency is defined
- webhook verification works where applicable
- tenant isolation is verified
- E2E test passes
- failure test passes
- disconnect/reconnect works

Use separate statuses:

```text
IMPLEMENTED
TESTED
VERIFIED
PRODUCTION VERIFIED
```

# 38. Final Enterprise Principle

The customer should see:

```text
CONNECT
↓
AUTHENTICATE
↓
SCOPE
↓
TEST
↓
HEALTH
↓
ASSIGN
↓
READY
```

Internally Orlixa handles:

```text
OAuth
API Key
SMTP
IMAP
Self-hosted Engines
Webhooks
Scopes
Repositories
Folders
Projects
Workspaces
Mailboxes
Social Accounts
Authorization
Approval
Audit
Idempotency
Observability
```

The customer should not need to understand the internal architecture.

# 39. Final Architecture

```text
                         ORLIXA
                           │
                     AI Employee
                           │
                        Workflow
                           │
                    Skill Requirement
                           │
                       SkillExecutor
                           │
                  ┌────────┴────────┐
                  │                 │
             Authorization       Approval
                  │                 │
                  └────────┬────────┘
                           ↓
                    Resolve Connection
                           │
              ┌────────────┼─────────────┐
              │            │             │
            OAuth        API Key      SMTP/IMAP
              │            │             │
              └────────────┼─────────────┘
                           ↓
                    Provider Adapter
                           │
          ┌────────────────┼────────────────┐
          │                │                │
       Gmail            Slack           Stripe
       GitHub          HubSpot           Jira
       Calendar       Google Drive       HTTP
       Email          Postiz            Chatwoot
                                      Plane
          │                │                │
          └────────────────┼────────────────┘
                           ↓
                    External Action
                           │
                    Result / Event
                           │
                  ┌────────┴────────┐
                  │                 │
              Reconcile           Audit
                  │                 │
                  └────────┬────────┘
                           ↓
                    Durable Runtime
                           │
                        Next Step
```

# 40. Final CTO Decision

Do NOT build 14 completely independent connection systems.

Build:

```text
ONE Skill Connection Framework
+
Provider-specific Adapters
+
Central Authorization
+
Central Approval
+
Central Audit
+
Central Health
+
Central Idempotency
```

This allows Orlixa to add providers without redesigning the entire Skill system.
