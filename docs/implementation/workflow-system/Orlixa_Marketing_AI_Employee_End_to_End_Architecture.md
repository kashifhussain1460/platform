# Orlixa — Marketing AI Employee
## End-to-End Enterprise Architecture & Functional Specification

**Version:** 1.0  
**Status:** Architecture Baseline  
**Product:** Orlixa  
**Module:** Marketing AI Employee  
**Architecture Rating Target:** 9.5/10

---

# 1. Executive Summary

Orlixa is a multi-tenant AI Employee platform where organizations can hire and configure AI Employees to perform business capabilities.

The Marketing AI Employee is responsible for:

- Marketing strategy
- Campaign planning
- Content calendar generation
- Social media content generation
- Creative/image/video generation
- Platform-specific content adaptation
- Human review and approval
- Social media scheduling
- Multi-platform publishing
- Publishing failure/retry management
- Campaign analytics
- Performance analysis
- Future campaign recommendations

The architecture must be designed so that the Marketing AI Employee is **not tightly coupled to any social-media provider**.

The core principle is:

```text
Organization
    ↓
AI Employee
    ↓
Capabilities
    ↓
Integration Layer
    ↓
External Assets
    ↓
Campaign
    ↓
Content Plan
    ↓
Creative Variants
    ↓
Quality / Policy
    ↓
Human Approval
    ↓
Execution Engine
    ↓
Provider APIs
    ↓
Analytics
    ↓
AI Recommendations
```

The AI plans and recommends.

The execution layer executes.

The organization controls permissions and approval.

---

# 2. Product Vision

The Marketing AI Employee should behave like a real marketing employee rather than a simple content-generation chatbot.

A user should be able to say:

> "Create a one-week marketing campaign for our new product. Post 3 times per day on LinkedIn, Facebook and Instagram. Generate different creative options, use our brand guidelines, and ask me for approval before anything is published."

Orlixa should transform that natural-language request into:

```text
Task
 ↓
Intent
 ↓
Strategy
 ↓
Content Calendar
 ↓
21 Content Items
 ↓
5–6 Variants Per Content Item
 ↓
Text + Image/Video
 ↓
Platform Adaptation
 ↓
QA
 ↓
Human Review
 ↓
Approval
 ↓
Scheduling
 ↓
Publishing
 ↓
Analytics
 ↓
Optimization
```

---

# 3. Core Architectural Principles

## 3.1 Multi-Tenancy First

Every business operation is scoped to an organization.

```text
organization_id
```

must be part of the authorization boundary.

No organization can access another organization's:

- AI Employees
- Integrations
- OAuth credentials
- Campaigns
- Content
- Media
- Approvals
- Publishing jobs
- Analytics

---

## 3.2 AI and Execution Must Be Separate

The AI must not directly execute external actions.

```text
AI
 ↓
Plan / Generate / Recommend
 ↓
Approval
 ↓
Execution Engine
 ↓
External API
```

Never:

```text
AI
 ↓
Raw OAuth Token
 ↓
Social API
```

---

## 3.3 Integration Provider Independence

The AI should not contain LinkedIn-specific, Meta-specific, or Google-specific business logic.

Instead:

```text
Marketing AI
     ↓
Capability
     ↓
Integration Service
     ↓
Provider Adapter
     ↓
External API
```

---

## 3.4 Human-in-the-Loop

When approval is enabled:

```text
Generated Content
       ↓
Review
       ↓
Explicit Approval
       ↓
Schedule
       ↓
Publish
```

Generation does not equal approval.

Viewing does not equal approval.

Saving does not equal approval.

---

## 3.5 Versioned Approval

Every approved content item must have a version.

If:

```text
Version 3
```

was approved and then content changes to:

```text
Version 4
```

the approval must become invalid.

Publishing must verify:

```text
approved_version === current_version
```

---

## 3.6 Async by Default

Large campaigns must not be generated inside one HTTP request.

Use:

```text
API
 ↓
Queue
 ↓
Workers
```

---

## 3.7 Idempotent Execution

Publishing must be safe to retry.

Before publishing:

```text
Already published?
   ↓
Yes → Return existing result
No  → Publish
```

---

# 4. High-Level Architecture

```text
                         ORLIXA
                           │
                           ▼
                 Organization Context
                           │
                           ▼
                 Marketing AI Employee
                           │
                     Capability Layer
                           │
       ┌───────────────────┼───────────────────┐
       ▼                   ▼                   ▼
   Strategy             Content             Analytics
       │                   │                   │
       └───────────────────┼───────────────────┘
                           ▼
                  Integration Layer
                           │
          ┌────────────────┼────────────────┐
          ▼                ▼                ▼
       LinkedIn           Meta           Google
          │                │                │
          ▼                ▼                ▼
        Assets           Assets           Assets
          │                │                │
          └────────────────┼────────────────┘
                           ▼
                        Campaign
                           │
                           ▼
                     Content Plan
                           │
                           ▼
                  Content Items
                           │
                           ▼
                  5–6 Creative Variants
                           │
                  ┌────────┴────────┐
                  ▼                 ▼
               Content             Media
                  │                 │
                  └────────┬────────┘
                           ▼
                    QA / Policy Layer
                           │
                           ▼
                    Human Approval
                           │
                           ▼
                    Execution Engine
                           │
                           ▼
                     Publish Queue
                           │
                           ▼
                    Provider APIs
                           │
                           ▼
                       Analytics
                           │
                           ▼
                    AI Optimization
```

---

# 5. Organization Context

The AI Employee must operate using organization context.

Recommended organization marketing profile:

```text
Brand Name
Industry
Website
Products
Services
Target Audience
Value Proposition
Brand Voice
Brand Personality
Brand Colors
Brand Guidelines
Preferred CTA
Preferred Hashtags
Forbidden Claims
Competitors
Marketing Goals
```

Example:

```text
Organization:
Acme Inc.

Industry:
SaaS

Target Audience:
SMBs

Brand Voice:
Professional + Friendly

CTA:
Book a Demo

Forbidden:
Unverified performance claims
```

The AI should use this context during generation.

---

# 6. AI Employee Model

The Marketing AI Employee is an orchestrator.

It should not be a single giant prompt with every responsibility.

Recommended capabilities:

```text
Marketing AI Employee
│
├── Strategy Capability
├── Research Capability
├── Campaign Planning
├── Content Generation
├── Creative Generation
├── Platform Adaptation
├── Quality Assurance
├── Approval Management
├── Scheduling
├── Publishing
├── Analytics
└── Optimization
```

---

# 7. Capability Architecture

Each capability has:

```text
Input
 ↓
Context
 ↓
Policy
 ↓
AI/Business Logic
 ↓
Output
```

Example:

```text
Content Generation
Input:
Campaign + Brand Context + Content Objective

Output:
5–6 creative variants
```

Publishing:

```text
Publishing Capability
Input:
Approved Content + Platform Asset

Output:
Publication Result
```

---

# 8. Marketing Task

Users interact with the Marketing AI through natural language.

Example:

> Create a 7-day campaign for our new product with 2–5 posts per day across LinkedIn, Facebook and Instagram.

The system extracts:

```text
duration = 7 days
posts_per_day_min = 2
posts_per_day_max = 5

platforms:
- LinkedIn
- Facebook
- Instagram
```

Additional information may include:

```text
objective
content_types
media_preferences
approval_policy
timezone
start_date
end_date
```

---

# 9. Task Normalization

Natural language should be converted to a structured task.

Conceptual object:

```json
{
  "objective": "product awareness",
  "duration_days": 7,
  "posts_per_day": {
    "min": 2,
    "max": 5
  },
  "platforms": [
    "linkedin",
    "facebook",
    "instagram"
  ],
  "media": [
    "image",
    "video"
  ],
  "approval_required": true
}
```

Before execution, validate the task.

---

# 10. Campaign Planning

The AI first creates a campaign strategy.

Example:

```text
Campaign Objective:
Product Awareness

Audience:
Small and medium businesses

Content Pillars:
1. Education
2. Product
3. Customer Problem
4. Social Proof
5. Engagement
6. Promotion
```

The AI should distribute content types across the campaign rather than repeating the same format.

---

# 11. Content Calendar

The strategy produces a calendar.

For:

```text
7 days
2–5 posts/day
```

the system must generate between:

```text
14–35 content items
```

Example:

| Day | Post | Objective | Type |
|---|---|---|---|
| Monday | 1 | Awareness | Educational |
| Monday | 2 | Engagement | Question |
| Tuesday | 1 | Product | Feature |
| Tuesday | 2 | Education | Tips |
| Wednesday | 1 | Social Proof | Customer Story |
| Wednesday | 2 | Engagement | Poll |
| Thursday | 1 | Product | Demo |
| Thursday | 2 | Education | How-to |
| Friday | 1 | Promotion | Offer |
| Friday | 2 | Engagement | Question |

The calendar should be generated before full content generation.

---

# 12. Content Item

A content item represents a planned piece of content.

Example:

```text
Content Item
├── Day
├── Schedule
├── Objective
├── Content Type
├── Platforms
└── Creative Variants
```

A content item is not the same thing as a platform publication.

---

# 13. Creative Variants

## Mandatory requirement

Every content item must have **5–6 complete creative options**.

Not:

```text
6 captions + 1 image
```

Instead:

```text
Content Item
│
├── Variant 1
│   ├── Hook
│   ├── Caption
│   ├── CTA
│   ├── Hashtags
│   └── Media
│
├── Variant 2
│   ├── Hook
│   ├── Caption
│   ├── CTA
│   ├── Hashtags
│   └── Media
│
├── Variant 3
│   └── ...
│
├── Variant 4
│   └── ...
│
├── Variant 5
│   └── ...
│
└── Variant 6
    └── ...
```

Each option must be meaningfully different.

---

# 14. Variant Requirements

Every variant should contain:

```text
Hook
Caption
CTA
Hashtags
Content Angle
Media Brief
Generated Media
```

Optional:

```text
Suggested Posting Time
Target Audience Segment
Expected Goal
```

---

# 15. Creative Diversity

Variants should differ by:

- Hook
- Story angle
- Content structure
- CTA
- Visual concept
- Tone where appropriate
- Hashtag strategy

Avoid:

```text
Variant 1:
Buy our product today.

Variant 2:
Buy our product now.

Variant 3:
Purchase our product.
```

These are not meaningful alternatives.

---

# 16. Media Generation

Each variant may have its own:

```text
Image
Video
Carousel
Text-only creative
```

Example:

```text
Variant 1
 ├── Caption
 └── Image

Variant 2
 ├── Caption
 └── Video

Variant 3
 ├── Caption
 └── Image
```

Media should be generated according to:

- Campaign objective
- Brand guidelines
- Platform requirements
- Content type
- User preferences

---

# 17. Media Pipeline

```text
Content Variant
      ↓
Media Brief
      ↓
Generation Provider
      ↓
Media Validation
      ↓
Storage
      ↓
Preview
```

Validate:

```text
MIME type
Width
Height
Aspect Ratio
File Size
Video Duration
Platform Compatibility
```

---

# 18. Content vs Creative vs Publication

These must be separate concepts.

```text
Campaign
   ↓
Content Item
   ↓
Creative Variant
   ↓
Selected Creative
   ↓
Platform Publication
```

Example:

```text
Creative #12
   │
   ├── LinkedIn Publication
   ├── Facebook Publication
   └── Instagram Publication
```

This enables platform-specific adaptation.

---

# 19. Platform Adaptation

Do not blindly publish identical content everywhere.

```text
Base Creative
      │
      ├── LinkedIn Version
      ├── Facebook Version
      └── Instagram Version
```

Adapt:

- Caption
- CTA
- Hashtags
- Tone
- Length
- Media dimensions
- Platform-specific behavior
- Links
- Mentions
- Character limits

The core campaign message should remain consistent.

---

# 20. Social Integration Architecture

Use a generic integration abstraction.

```text
SocialProviderAdapter

connect()
disconnect()
refreshToken()
getAssets()
validateContent()
publish()
getPublicationStatus()
getAnalytics()
```

Provider implementations:

```text
LinkedInAdapter
MetaAdapter
InstagramAdapter
GoogleAdapter
FutureProviderAdapter
```

The Marketing AI must use the interface, not the provider implementation.

---

# 21. Integration Connection Model

```text
Organization
     ↓
Integration Connection
     ↓
External Account
     ↓
External Business Assets
```

Example:

```text
Acme Inc.
│
└── LinkedIn Connection
      │
      ├── Authorized User
      └── Acme Company Page
```

Meta:

```text
Acme Inc.
│
└── Meta Connection
      ├── Facebook Page
      ├── Instagram Business Account
      └── Ad Account
```

---

# 22. Integration Data Model

Conceptual:

```text
organization_integrations

id
organization_id
provider
integration_type
status
connected_by_user_id
external_account_id
external_account_name
access_token_encrypted
refresh_token_encrypted
token_expires_at
scopes
metadata
created_at
updated_at
```

Never expose encrypted credentials to the frontend or AI model.

---

# 23. Integration Assets

Recommended:

```text
integration_assets

id
organization_id
integration_id
external_asset_id
asset_type
name
status
metadata
created_at
updated_at
```

Examples:

```text
LinkedIn Company Page
Facebook Page
Instagram Business Account
Google Ads Account
```

---

# 24. OAuth Architecture

OAuth belongs to the integration layer.

```text
User
 ↓
Orlixa
 ↓
Provider OAuth
 ↓
Authorization
 ↓
Callback
 ↓
Backend
 ↓
Token Storage
 ↓
Asset Discovery
 ↓
Asset Selection
 ↓
Active Connection
```

The business email is not automatically the authentication provider.

For example:

```text
john@acme.com
```

may authorize:

```text
LinkedIn
Meta
Google
```

through their respective OAuth systems.

---

# 25. Provider Verification

Provider verification is independent.

```text
Google Verification
≠
LinkedIn Verification
≠
Meta Verification
```

Each provider has its own:

- Developer application
- OAuth configuration
- Scopes
- Permissions
- Review process
- Rate limits
- API rules

Orlixa must manage these independently.

---

# 26. Approval Architecture

Approval must be explicit.

Recommended lifecycle:

```text
DRAFT
 ↓
GENERATING
 ↓
READY_FOR_REVIEW
 ↓
EDIT_REQUIRED / SELECTED
 ↓
APPROVED
 ↓
SCHEDULED
 ↓
PUBLISHING
 ↓
PUBLISHED
```

---

# 27. Approval Versioning

Every content change creates a new version.

Example:

```text
Content Version 1
 ↓
User edits
 ↓
Version 2
 ↓
User approves Version 2
```

If Version 2 changes after approval:

```text
Version 3
```

then:

```text
Approval = INVALID
```

Publishing cannot proceed until Version 3 is approved.

---

# 28. Approval Data Model

Conceptual:

```text
approvals

id
organization_id
campaign_id
content_item_id
variant_id
approved_by_user_id
approved_version
approval_scope
status
approved_at
created_at
```

Approval scopes:

```text
POST
CAMPAIGN
```

---

# 29. Campaign-Level Approval

Example:

```text
35 posts generated
        ↓
User reviews
        ↓
Approve Campaign
        ↓
Approved posts become schedulable
```

---

# 30. Post-Level Approval

Example:

```text
Post 1 → Approved
Post 2 → Rejected
Post 3 → Approved
Post 4 → Edit Required
```

The organization should be able to configure the approval policy.

---

# 31. UX for Variants

Do not overwhelm users.

For 35 posts × 6 variants:

```text
210 variants
```

should not all be expanded simultaneously.

Recommended UX:

```text
Campaign
 ↓
Day
 ↓
Post
 ↓
AI Recommended Variant
 ↓
Other Variants
```

Example:

```text
Monday — Post 1

⭐ AI Recommended
Variant 4

[Preview]

Other options
  Variant 1
  Variant 2
  Variant 3
  Variant 5
  Variant 6
```

Users can expand all options when needed.

---

# 32. AI Recommendation

The AI may recommend one variant based on:

- Campaign objective
- Brand fit
- Content quality
- Platform suitability
- Historical performance
- Diversity
- User preferences

But recommendation is not approval.

```text
AI Recommended
≠
User Approved
```

---

# 33. Campaign Review Screen

Example:

```text
Campaign: Summer Launch

Monday
──────────────────────

09:00 AM
Post 1

Platforms:
✓ LinkedIn
✓ Facebook
✓ Instagram

⭐ Recommended Variant 4

[Media Preview]

Caption:
...

#Marketing #AI #Business

[Select]
[Edit]
[Regenerate]

──────────────────────

02:00 PM
Post 2
...
```

Actions:

```text
Save Draft
Edit
Regenerate
Select Variant
Approve Post
Approve Campaign
```

---

# 34. Scheduling Architecture

Campaign approval and scheduling should be separate.

```text
Campaign
 ↓
Approved Content
 ↓
Schedule
 ↓
Publication Jobs
```

This allows:

> Move Friday's post from 10 AM to 3 PM

without regenerating content.

---

# 35. Timezone

Every campaign should have an explicit timezone.

Example:

```text
Asia/Kolkata
Europe/London
America/New_York
```

Never depend on server timezone.

Store:

```text
scheduled_at
timezone
```

and convert to the provider's required format.

---

# 36. Publishing Architecture

Publishing must be asynchronous.

```text
Approved Publication
       ↓
Publishing Queue
       ↓
Worker
       ↓
Provider Adapter
       ↓
External API
```

Do not publish all platforms in one synchronous request.

---

# 37. Publication Job Model

Conceptual:

```text
publication_jobs

id
organization_id
campaign_id
content_item_id
integration_id
asset_id
scheduled_at
status
attempts
last_attempt_at
published_at
external_post_id
error_code
error_message
created_at
updated_at
```

Statuses:

```text
PENDING
QUEUED
PUBLISHING
PUBLISHED
FAILED
RETRYING
CANCELLED
```

---

# 38. Independent Platform Jobs

For one content item:

```text
Content #17
│
├── LinkedIn Job
├── Facebook Job
└── Instagram Job
```

If:

```text
LinkedIn ✓
Facebook ✗
Instagram ✓
```

the campaign is not entirely failed.

The Facebook job can be retried independently.

---

# 39. Retry Architecture

```text
Attempt 1
 ↓
Failed
 ↓
Retry
 ↓
Attempt 2
 ↓
Retry
 ↓
Attempt 3
 ↓
Permanent Failure
```

Do not retry permanent errors such as:

- Revoked permissions
- Invalid credentials
- Unsupported media
- Invalid account
- Permanently rejected content

---

# 40. Idempotency

Before publishing:

```text
Check publication job
       ↓
Already published?
 ├── Yes → Return existing result
 └── No  → Execute
```

This prevents duplicate posts when workers retry.

---

# 41. Execution Engine

The execution engine is responsible for real-world actions.

```text
Execution Engine
│
├── Authorization Check
├── Policy Check
├── Approval Check
├── Version Check
├── Credential Retrieval
├── Provider Validation
├── API Execution
├── Result Storage
└── Audit Event
```

Before publishing:

```text
Organization valid?
✓

Connection active?
✓

Asset authorized?
✓

Approval valid?
✓

Version matches?
✓

Scheduled time reached?
✓
```

Only then publish.

---

# 42. AI Security Boundary

Never allow:

```text
AI Model
 ↓
Raw OAuth Token
```

Correct:

```text
AI
 ↓
"Publish content"
 ↓
Execution Engine
 ↓
Permission Check
 ↓
Credential Vault
 ↓
Provider API
```

The AI only requests an action.

---

# 43. Organization Permissions

Recommended permissions:

```text
MARKETING_VIEW
MARKETING_GENERATE
MARKETING_EDIT
MARKETING_APPROVE
MARKETING_SCHEDULE
MARKETING_PUBLISH
MARKETING_INTEGRATION_MANAGE
MARKETING_ANALYTICS_VIEW
```

A user without:

```text
MARKETING_PUBLISH
```

must not be able to publish.

---

# 44. AI Employee Permissions

AI Employee capabilities should also be policy-controlled.

Example:

```text
Marketing AI
│
├── Generate Content      ✓
├── Generate Media        ✓
├── Recommend Content     ✓
├── Schedule Content      ✓
└── Publish Content       ✗
```

Or an organization may explicitly enable:

```text
Publish Content           ✓
```

but only when its configured policy permits it.

---

# 45. Brand Safety

Before content reaches approval:

```text
Generated Content
 ↓
Brand Safety
 ↓
Policy Check
 ↓
Quality Check
```

Check:

- Brand voice
- Grammar
- Claims
- Restricted topics
- Required disclaimers
- Forbidden terms
- Competitor references
- Platform rules

---

# 46. Duplicate Content Detection

Campaign-level deduplication:

```text
New Content
 ↓
Compare Existing Campaign
 ↓
Similarity Check
 ↓
Too Similar?
 ├── Yes → Regenerate
 └── No  → Continue
```

Check:

- Hook similarity
- Caption similarity
- Content angle
- Hashtags
- Visual similarity

---

# 47. Hashtag Generation

Hashtags should be generated using:

```text
Brand
+
Industry
+
Campaign Objective
+
Content Topic
+
Platform
```

Avoid blindly generating large hashtag lists.

Use relevant hashtags.

---

# 48. Analytics Architecture

After publishing:

```text
Provider APIs
 ↓
Analytics Sync
 ↓
Normalized Metrics
 ↓
Campaign Analytics
 ↓
AI Analysis
```

Potential metrics:

```text
Impressions
Reach
Likes
Comments
Shares
Clicks
Engagement Rate
Video Views
Conversions
```

Availability depends on the provider/API.

---

# 49. Normalized Analytics Model

Provider-specific data should be normalized.

Conceptual:

```text
analytics_snapshots

id
organization_id
campaign_id
content_item_id
integration_id
external_post_id
metric_type
metric_value
captured_at
metadata
```

This allows multiple providers to be compared.

---

# 50. AI Performance Analysis

Example:

```text
Campaign Results

LinkedIn:
Educational content → High engagement

Instagram:
Video → High reach

Facebook:
Promotional content → High clicks
```

AI recommendation:

> Educational LinkedIn posts performed better than promotional posts. Increase educational content in the next campaign.

---

# 51. Closed-Loop AI Employee

The Marketing AI Employee should continuously improve:

```text
Plan
 ↓
Create
 ↓
Review
 ↓
Approve
 ↓
Publish
 ↓
Measure
 ↓
Analyze
 ↓
Learn
 ↓
Recommend
 ↓
Plan Next Campaign
```

This closed loop is a core differentiator of Orlixa.

---

# 52. Event Architecture

Recommended domain events:

```text
campaign.created
campaign.generation.started
campaign.generation.completed

content.generated
content.qa.completed
content.approved
content.rejected
content.updated

campaign.approved
campaign.scheduled

publication.queued
publication.started
publication.succeeded
publication.failed

integration.connected
integration.disconnected
integration.authorization_failed
integration.token_expired

analytics.sync.started
analytics.sync.completed
```

Events should decouple modules.

---

# 53. Background Job Architecture

Recommended workers:

```text
Queue
│
├── Strategy Worker
├── Content Worker
├── Media Worker
├── QA Worker
├── Platform Adaptation Worker
├── Scheduling Worker
├── Publishing Worker
├── Analytics Worker
└── Optimization Worker
```

Jobs should be independently retryable.

---

# 54. Recommended Backend Architecture

For NestJS:

```text
src/
├── modules/
│   ├── organizations/
│   ├── ai-employees/
│   │
│   ├── marketing/
│   │   ├── strategy/
│   │   ├── campaigns/
│   │   ├── content/
│   │   ├── variants/
│   │   ├── media/
│   │   ├── qa/
│   │   ├── approvals/
│   │   ├── scheduling/
│   │   ├── publishing/
│   │   └── analytics/
│   │
│   └── integrations/
│       ├── common/
│       ├── linkedin/
│       ├── meta/
│       ├── google/
│       └── future-providers/
│
├── infrastructure/
│   ├── database/
│   ├── queue/
│   ├── storage/
│   ├── encryption/
│   └── observability/
│
└── shared/
    ├── auth/
    ├── permissions/
    ├── events/
    ├── errors/
    └── utils/
```

---

# 55. Provider Adapter Interface

Conceptually:

```text
interface SocialProviderAdapter {
  connect()
  disconnect()
  refreshToken()
  getAssets()
  validateContent()
  publish()
  getPublicationStatus()
  getAnalytics()
}
```

Provider modules implement the interface.

The core marketing domain should not depend on provider-specific SDKs.

---

# 56. Frontend Architecture

Recommended Next.js structure:

```text
app/
├── dashboard/
│
├── ai-employees/
│   └── marketing/
│       ├── page.tsx
│       ├── create/
│       ├── campaigns/
│       │   └── [campaignId]/
│       └── integrations/
│
└── settings/
    └── integrations/
```

Reusable components:

```text
components/
├── marketing/
│   ├── CampaignBuilder
│   ├── CampaignCalendar
│   ├── ContentCard
│   ├── VariantSelector
│   ├── MediaPreview
│   ├── ApprovalPanel
│   ├── PlatformSelector
│   ├── ScheduleEditor
│   └── PublishingStatus
│
└── integrations/
    ├── IntegrationCard
    ├── ConnectButton
    ├── ConnectionStatus
    └── AssetSelector
```

---

# 57. Campaign Builder

Fields:

```text
Campaign Name
Objective
Description

Start Date
End Date
Timezone

Minimum Posts / Day
Maximum Posts / Day

Platforms

Content Pillars
Content Types

Image / Video / Carousel

Approval Policy
```

Natural-language input can populate these automatically.

---

# 58. Campaign Dashboard

Recommended sections:

```text
Campaign Overview
Content Calendar
Needs Review
Scheduled
Published
Failed
Analytics
AI Insights
```

Summary:

```text
Total Posts: 21
Approved: 18
Pending Review: 3
Scheduled: 18
Published: 12
Failed: 1
```

---

# 59. Campaign Calendar

Calendar must display:

```text
Date
Time
Content
Platforms
Status
Selected Variant
Approval
Publication Status
```

Example:

```text
Monday
09:00 → Post 1 → Approved → Scheduled
14:00 → Post 2 → Review
18:00 → Post 3 → Approved → Scheduled
```

---

# 60. Notification System

Notify users when:

```text
Campaign generation completed
Content requires review
Campaign approved
Campaign scheduled
Post published
Post failed
Connection expired
Connection revoked
Permission changed
Analytics available
AI recommendation available
```

---

# 61. Audit Trail

Every critical action must be recorded.

Example:

```text
Campaign Created
 ↓
AI Generated Content
 ↓
User Selected Variant 4
 ↓
User Edited Caption
 ↓
User Approved Version 3
 ↓
Scheduled
 ↓
Published
```

Recommended fields:

```text
id
organization_id
actor_type
actor_id
action
entity_type
entity_id
old_value
new_value
timestamp
metadata
```

---

# 62. Data Model

Core relationships:

```text
organizations
    │
    ├── users
    │
    ├── ai_employees
    │
    ├── organization_integrations
    │       │
    │       └── integration_assets
    │
    └── campaigns
            │
            ├── content_items
            │      │
            │      └── creative_variants
            │              │
            │              └── media_assets
            │
            ├── approvals
            │
            └── publication_jobs
                    │
                    └── publication_results
```

Analytics should remain separately queryable.

---

# 63. Suggested Core Tables

```text
organizations

ai_employees

organization_integrations

integration_assets

campaigns

content_items

creative_variants

media_assets

approvals

publication_jobs

publication_results

analytics_snapshots

audit_logs
```

---

# 64. Campaign Table

Suggested:

```text
campaigns

id
organization_id
ai_employee_id
created_by_user_id
name
objective
description
start_date
end_date
timezone
posts_per_day_min
posts_per_day_max
approval_required
status
created_at
updated_at
```

---

# 65. Content Item Table

Suggested:

```text
content_items

id
organization_id
campaign_id
day_number
sequence
objective
content_type
scheduled_at
timezone
current_version
selected_variant_id
status
created_at
updated_at
```

---

# 66. Creative Variant Table

Suggested:

```text
creative_variants

id
organization_id
content_item_id
variant_number
version
hook
caption
cta
hashtags
content_angle
status
created_at
updated_at
```

---

# 67. Media Asset Table

Suggested:

```text
media_assets

id
organization_id
campaign_id
content_item_id
variant_id
type
storage_key
thumbnail_key
mime_type
width
height
duration
generation_provider
generation_prompt
status
created_at
updated_at
```

---

# 68. Publication Result

Recommended:

```text
publication_results

id
organization_id
publication_job_id
provider
external_post_id
status
published_at
response_metadata
error_code
error_message
created_at
updated_at
```

---

# 69. Security Model

Required:

```text
Authentication
+
Organization Authorization
+
Role Permissions
+
AI Capability Permissions
+
Integration Permissions
+
Approval Validation
+
Execution Validation
```

All external actions must pass authorization checks.

---

# 70. Credential Security

OAuth credentials must:

- Be encrypted at rest
- Never be sent to frontend
- Never be sent to AI models
- Never appear in logs
- Have restricted backend access
- Support refresh
- Support revocation
- Track scopes
- Track expiration
- Support disconnect

---

# 71. Secret Management

Prefer a dedicated secret/credential layer.

Conceptually:

```text
Execution Service
      ↓
Credential Service
      ↓
Encrypted Secret Storage
      ↓
Provider API
```

The exact implementation can use the infrastructure already selected for Orlixa.

---

# 72. API Design

Suggested APIs:

```text
POST   /marketing/campaigns
GET    /marketing/campaigns
GET    /marketing/campaigns/:id

POST   /marketing/campaigns/:id/generate
POST   /marketing/campaigns/:id/regenerate

GET    /marketing/campaigns/:id/content
GET    /marketing/content/:id/variants

POST   /marketing/content/:id/select-variant
PATCH  /marketing/content/:id

POST   /marketing/content/:id/approve
POST   /marketing/campaigns/:id/approve

POST   /marketing/campaigns/:id/schedule
POST   /marketing/publications/:id/retry

GET    /marketing/campaigns/:id/analytics

GET    /integrations
POST   /integrations/:provider/connect
GET    /integrations/:provider/callback
POST   /integrations/:id/disconnect
GET    /integrations/:id/assets
```

Exact endpoint naming can follow the existing Orlixa API conventions.

---

# 73. API Rules

All endpoints must:

1. Authenticate user.
2. Resolve organization.
3. Check authorization.
4. Validate request.
5. Execute domain operation.
6. Emit relevant event.
7. Return normalized response.

Never trust `organization_id` supplied blindly by the frontend.

Resolve tenant context from authenticated membership/session wherever possible.

---

# 74. Async Generation API

Generation should return a job reference.

Example:

```text
POST /marketing/campaigns/:id/generate

Response:

{
  "campaignId": "...",
  "jobId": "...",
  "status": "GENERATING"
}
```

Frontend then observes job progress.

---

# 75. Real-Time Progress

Recommended UI:

```text
Campaign Generation

Strategy                ✓
Content Calendar        ✓
Monday                  ✓
Tuesday                 ✓
Wednesday               70%
Thursday                —
Media                   —
QA                      —

21 / 35 Content Items
```

Use the existing Orlixa real-time/event infrastructure where available.

---

# 76. Campaign Generation State Machine

```text
DRAFT
 ↓
ANALYZING
 ↓
PLANNING
 ↓
GENERATING
 ↓
MEDIA_GENERATING
 ↓
QUALITY_CHECK
 ↓
READY_FOR_REVIEW
```

---

# 77. Campaign Approval State Machine

```text
READY_FOR_REVIEW
 ↓
PARTIALLY_APPROVED
 ↓
APPROVED
```

Possible branches:

```text
EDIT_REQUIRED
REJECTED
CANCELLED
```

---

# 78. Publishing State Machine

```text
APPROVED
 ↓
SCHEDULED
 ↓
QUEUED
 ↓
PUBLISHING
 ↓
PUBLISHED
```

Failure:

```text
PUBLISHING
 ↓
FAILED
 ↓
RETRYING
 ↓
PUBLISHED
```

or:

```text
FAILED
 ↓
PERMANENT_FAILURE
```

---

# 79. Failure Isolation

One provider failure must not block unrelated providers.

Example:

```text
Post #17

LinkedIn       PUBLISHED ✓
Instagram      PUBLISHED ✓
Facebook       FAILED ✗
```

The system should preserve successful results.

---

# 80. Provider Rate Limits

The publishing queue must account for provider limits.

```text
Provider
 ↓
Rate Limit Manager
 ↓
Queue
 ↓
Backoff
 ↓
Retry
```

Never assume all platforms have identical limits.

---

# 81. Observability

Track:

```text
Generation Duration
Generation Failures
Media Generation Failures
QA Failures
Approval Time
Queue Delay
Publishing Success Rate
Publishing Failure Rate
Provider API Latency
Token Refresh Failures
Analytics Sync Failures
```

Use structured logs with:

```text
organization_id
campaign_id
content_item_id
job_id
provider
```

Never log secrets.

---

# 82. Monitoring

Recommended dashboards:

```text
AI Generation
Publishing
Integrations
Queue
Provider Health
Analytics
```

Alert on:

```text
High publishing failure rate
Queue backlog
Repeated token failures
Provider outage
Generation failure spikes
```

---

# 83. Rate Limiting and Cost Controls

AI/media generation can become expensive.

Introduce:

```text
Organization AI Usage
Campaign Generation Budget
Media Generation Limits
Monthly Usage
Provider API Usage
```

Before expensive jobs:

```text
Check entitlement
Check quota
Check budget
Queue job
```

---

# 84. Entitlement Integration

Because Orlixa is an AI Employee platform, marketing capabilities should respect organization plan/entitlements.

Example:

```text
Plan
 ↓
Marketing AI Enabled?
 ↓
Monthly Generation Limit
 ↓
Media Generation Limit
 ↓
Publishing Limit
```

Do not hard-code plan logic inside Marketing modules.

Use the central Orlixa entitlement/capability system.

---

# 85. AI Context Resolution

Marketing AI should resolve:

```text
Organization
 ↓
Plan / Entitlements
 ↓
Industry
 ↓
Brand Context
 ↓
Departments
 ↓
User Role
 ↓
Marketing AI Employee
 ↓
Enabled Capabilities
 ↓
Connected Integrations
```

Only then should the AI decide what it can do.

---

# 86. AI Tool Boundary

Expose controlled tools to the AI.

Examples:

```text
create_campaign_plan
generate_content_variants
generate_media_brief
request_media_generation
check_integrations
get_social_assets
create_draft
request_approval
get_campaign_analytics
generate_recommendation
```

Publishing should be a controlled execution capability, not a raw provider tool.

---

# 87. Tool Permission Example

```text
Marketing AI

CAN:
✓ Read organization marketing context
✓ Generate content
✓ Generate media
✓ Read connected assets
✓ Create campaign drafts
✓ Recommend variants
✓ Analyze analytics

CANNOT:
✗ Read OAuth tokens
✗ Access another organization
✗ Publish without policy permission
✗ Bypass approval
✗ Modify approved content silently
```

---

# 88. Human Approval Rule

Before execution:

```text
1. Is organization active?
2. Is user authorized?
3. Is integration active?
4. Is external asset authorized?
5. Is content approved?
6. Is approved version current?
7. Is publication time valid?
8. Is provider content valid?
```

If any required check fails:

```text
DO NOT PUBLISH
```

---

# 89. Example End-to-End Flow

## User Request

> Create a 7-day campaign for our new SaaS product. Post 3 times a day on LinkedIn, Facebook and Instagram. Generate images/videos and let me approve everything before publishing.

---

## Step 1 — Task Analysis

```text
Duration = 7 days
Posts/day = 3
Total posts = 21
Platforms = 3
Approval = Required
```

---

## Step 2 — Context Resolution

```text
Organization
 ↓
Brand Context
 ↓
Marketing AI
 ↓
Connected Platforms
```

---

## Step 3 — Strategy

AI determines:

```text
Educational
Product
Social Proof
Engagement
Promotion
```

---

## Step 4 — Calendar

```text
21 content items
```

---

## Step 5 — Variant Generation

Each content item:

```text
6 variants
```

Total:

```text
21 × 6 = 126 variants
```

---

## Step 6 — Media

Each variant gets suitable media where requested.

---

## Step 7 — Platform Adaptation

Selected content is adapted for:

```text
LinkedIn
Facebook
Instagram
```

---

## Step 8 — QA

```text
Brand ✓
Grammar ✓
Claims ✓
Hashtags ✓
Media ✓
Platform ✓
Duplicates ✓
```

---

## Step 9 — User Review

User selects preferred variants.

---

## Step 10 — Approval

User explicitly approves campaign/content.

---

## Step 11 — Schedule

Publication jobs are created.

---

## Step 12 — Publish

Independent jobs execute:

```text
LinkedIn
Facebook
Instagram
```

---

## Step 13 — Result

```text
Published ✓
Published ✓
Failed → Retry
```

---

## Step 14 — Analytics

Collect available performance metrics.

---

## Step 15 — AI Analysis

AI identifies:

```text
Best content type
Best platform
Best posting time
Best creative format
Best CTA
```

---

## Step 16 — Next Campaign

AI recommends:

> "For the next campaign, increase educational video content on Instagram and product education on LinkedIn."

---

# 90. UX Principle: Recommended Variant First

For large campaigns, the UI should show:

```text
AI Recommended
```

first.

Then:

```text
Other 5 variants
```

on demand.

This prevents the user from being overwhelmed.

---

# 91. UX Principle: Never Hide User Control

The user must always be able to:

```text
Edit
Regenerate
Select
Reject
Approve
Reschedule
Remove Platform
Retry
Cancel
```

---

# 92. UX Principle: Explain Why

AI recommendations should optionally include a concise reason.

Example:

> Recommended because this variant matches your brand voice and uses an educational hook that has performed well in previous campaigns.

Do not expose internal chain-of-thought. Only provide concise user-facing rationale.

---

# 93. Content Versioning

Every editable content entity should be versioned.

```text
Post
 ├── Version 1
 ├── Version 2
 └── Version 3 ← Current
```

Approval attaches to a version.

Publishing attaches to a version.

This creates a reliable audit trail.

---

# 94. Campaign Snapshots

At approval time, create an immutable snapshot/reference of the approved content.

Conceptually:

```text
Campaign Approval
 ↓
Approved Snapshot
 ↓
Publication Jobs
```

This ensures later edits do not unexpectedly modify scheduled content.

---

# 95. Scheduled Content Lock

Once a post enters publishing:

```text
SCHEDULED
```

editing should follow controlled rules.

Possible:

```text
Edit
 ↓
Invalidate Approval
 ↓
Create New Version
 ↓
Reapprove
```

Do not silently modify scheduled content.

---

# 96. External Asset Selection

When connecting a provider, Orlixa should discover available assets.

Example:

```text
LinkedIn

Available Organizations:
○ Acme Inc.
○ Acme Careers
```

The user selects which assets the Marketing AI can operate.

This is safer than giving the integration unrestricted access to every asset.

---

# 97. Disconnect Behavior

When a provider is disconnected:

```text
Integration
 ↓
DISCONNECTED
```

Do not immediately destroy historical publication records.

Historical data should remain available.

Scheduled unpublished jobs should be handled according to policy:

```text
Pause / Cancel
```

---

# 98. Token Expiration

When access expires:

```text
Token Expired
 ↓
Attempt Refresh
 ↓
Success → Continue
Failure → Connection Action Required
```

Notify the organization if reconnect is required.

---

# 99. Revoked Authorization

If the provider reports revoked authorization:

```text
Connection
 ↓
REVOKED
 ↓
Disable Publishing
 ↓
Notify User
 ↓
Reconnect
```

Existing published history remains intact.

---

# 100. Testing Strategy

Testing must cover:

## Unit Tests

- Campaign planning
- Task normalization
- Variant generation orchestration
- Permission checks
- Approval version validation
- Schedule validation
- Provider adapter behavior
- Retry logic
- Idempotency

## Integration Tests

- OAuth callback
- Token refresh
- Asset discovery
- Provider API publishing
- Analytics synchronization

## E2E Tests

```text
Create Organization
 ↓
Connect Platform
 ↓
Create Campaign
 ↓
Generate
 ↓
Review
 ↓
Approve
 ↓
Schedule
 ↓
Publish
 ↓
Analytics
```

---

# 101. Critical Security Tests

Test:

```text
Organization A cannot access Organization B
```

```text
AI cannot read OAuth token
```

```text
Unapproved post cannot publish
```

```text
Edited approved post cannot publish without reapproval
```

```text
Revoked integration cannot publish
```

```text
Unauthorized user cannot approve
```

```text
Duplicate publishing cannot occur after retry
```

---

# 102. Performance Tests

Test large campaigns:

```text
35 posts
×
6 variants
=
210 variants
```

and media workloads.

Measure:

```text
Queue throughput
Worker concurrency
AI generation latency
Media generation latency
Database performance
Publishing throughput
```

---

# 103. Cost Control

A large campaign can generate substantial AI/media usage.

For example:

```text
35 content items
×
6 variants
=
210 variants
```

If every variant generates video, cost can become very high.

Therefore provide configurable media strategy:

```text
Generate media for all variants
OR
Generate media for selected/recommended variants
OR
Generate media after variant selection
```

Recommended default:

```text
Text concepts → 5–6 variants
Media → generate for selected/recommended variants
```

This reduces cost while preserving choice.

---

# 104. Recommended Generation Strategy

For each content item:

```text
Phase 1
Generate 5–6 text/creative concepts

Phase 2
Run quality scoring

Phase 3
Show 5–6 options

Phase 4
User selects

Phase 5
Generate final high-quality media

Phase 6
Platform adaptation

Phase 7
Approval
```

This is more cost-efficient than generating expensive video for all 6 variants upfront.

---

# 105. Recommended AI Pipeline

```text
USER TASK
   ↓
TASK NORMALIZATION
   ↓
CONTEXT RESOLUTION
   ↓
STRATEGY
   ↓
CONTENT CALENDAR
   ↓
CONTENT VARIANTS
   ↓
QUALITY SCORING
   ↓
USER SELECTION
   ↓
MEDIA GENERATION
   ↓
PLATFORM ADAPTATION
   ↓
FINAL QA
   ↓
HUMAN APPROVAL
   ↓
SCHEDULE
   ↓
EXECUTION
   ↓
ANALYTICS
   ↓
OPTIMIZATION
```

---

# 106. Why This Architecture Is Strong

This architecture solves:

### Multi-tenancy

Organization-scoped data.

### Provider independence

Adapters isolate social APIs.

### AI safety

AI cannot directly access credentials.

### Human control

Approval is explicit and versioned.

### Scalability

Async queues/workers.

### Reliability

Retries and idempotency.

### Extensibility

New providers can be added through adapters.

### AI Employee evolution

Analytics can feed future campaigns.

### Enterprise readiness

Permissions, audit logs, policy enforcement and tenant isolation.

---

# 107. Future Expansion

The same architecture can support additional AI Employees.

```text
Orlixa
│
├── Marketing AI Employee
│
├── Sales AI Employee
│
├── Customer Support AI Employee
│
├── HR AI Employee
│
├── Finance AI Employee
│
└── Operations AI Employee
```

Shared platform services:

```text
Organization Context
Capability Resolution
Permissions
Integrations
Credential Management
AI Orchestration
Queue
Audit
Notifications
Analytics
Entitlements
```

This prevents each AI Employee from building its own infrastructure.

---

# 108. Long-Term Integration Platform

The integration layer should eventually support:

```text
Social
├── LinkedIn
├── Facebook
├── Instagram
├── X
└── TikTok

Advertising
├── Google Ads
└── Meta Ads

Analytics
├── Google Analytics
├── LinkedIn Analytics
└── Meta Insights

CRM
├── HubSpot
└── Salesforce

Communication
├── Gmail
├── Microsoft 365
└── Slack
```

The Marketing AI consumes capabilities from this shared integration platform.

---

# 109. Architectural Anti-Patterns

Do NOT:

```text
❌ Put OAuth logic inside AI prompts
❌ Give OAuth tokens to AI
❌ Hard-code provider logic into Marketing service
❌ Treat campaign and publication as the same entity
❌ Treat creative variant and publication as the same entity
❌ Auto-publish when approval is required
❌ Publish all platforms in one transaction
❌ Generate an entire campaign in one HTTP request
❌ Assume business email means Gmail
❌ Assume all social platforms have the same API behavior
❌ Allow approved content to change silently
❌ Store raw tokens in logs
❌ Trust organization_id directly from frontend
❌ Generate expensive media unnecessarily
```

---

# 110. Golden Rules

## Rule 1

**AI plans.**

## Rule 2

**AI generates.**

## Rule 3

**AI recommends.**

## Rule 4

**Organization controls.**

## Rule 5

**Human approves when required.**

## Rule 6

**Execution service publishes.**

## Rule 7

**Integration layer owns provider communication.**

## Rule 8

**OAuth credentials never reach AI.**

## Rule 9

**Every organization is isolated.**

## Rule 10

**Every external action is auditable.**

---

# 111. Final Golden Architecture

```text
                              ORLIXA
                                │
                                ▼
                     Organization Context
                                │
                     ┌──────────┴──────────┐
                     │                     │
                Entitlements           Permissions
                     │                     │
                     └──────────┬──────────┘
                                ▼
                      Marketing AI Employee
                                │
                         Capability Layer
                                │
          ┌─────────────────────┼─────────────────────┐
          ▼                     ▼                     ▼
       Strategy              Content              Analytics
          │                     │                     │
          └─────────────────────┼─────────────────────┘
                                ▼
                       Integration Layer
                                │
               ┌────────────────┼────────────────┐
               ▼                ▼                ▼
            LinkedIn           Meta            Google
               │                │                │
               ▼                ▼                ▼
             Assets           Assets           Assets
               │                │                │
               └────────────────┼────────────────┘
                                ▼
                             Campaign
                                │
                                ▼
                          Content Calendar
                                │
                                ▼
                          Content Items
                                │
                                ▼
                       5–6 Creative Variants
                                │
                    ┌───────────┴───────────┐
                    ▼                       ▼
                 Content                   Media
                    │                       │
                    └───────────┬───────────┘
                                ▼
                       Quality / Policy QA
                                │
                                ▼
                       Human Review
                                │
                                ▼
                       Versioned Approval
                                │
                                ▼
                           Scheduling
                                │
                                ▼
                       Execution Engine
                                │
                         ┌──────┴──────┐
                         ▼             ▼
                   Permission      Version Check
                         │             │
                         └──────┬──────┘
                                ▼
                         Publishing Queue
                                │
                                ▼
                          Provider Adapters
                                │
                                ▼
                           External APIs
                                │
                                ▼
                        Publication Results
                                │
                                ▼
                             Analytics
                                │
                                ▼
                        AI Performance Analysis
                                │
                                ▼
                         Recommendations
                                │
                                ▼
                          Next Campaign
```

---

# 112. Final End-to-End Principle

The complete Orlixa Marketing AI Employee lifecycle is:

```text
UNDERSTAND
   ↓
PLAN
   ↓
GENERATE
   ↓
CREATE 5–6 OPTIONS
   ↓
SELECT
   ↓
CREATE FINAL MEDIA
   ↓
ADAPT
   ↓
VALIDATE
   ↓
APPROVE
   ↓
SCHEDULE
   ↓
EXECUTE
   ↓
PUBLISH
   ↓
MEASURE
   ↓
ANALYZE
   ↓
LEARN
   ↓
OPTIMIZE
   ↓
REPEAT
```

The final architecture should remain **provider-independent, organization-scoped, permission-controlled, human-governed, asynchronous, observable, auditable, and extensible**.

This architecture is intended to become the baseline for implementation, code review, QA, security review, and future Marketing AI Employee capabilities.
