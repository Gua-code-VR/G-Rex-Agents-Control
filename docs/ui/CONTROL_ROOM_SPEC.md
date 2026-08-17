# G-Rex Agent Control --- Control Room UI Specification

**Status:** Approved design direction\
**Purpose:** Official UI/UX reference for the redesign of G-Rex Agent
Control\
**Scope:** Desktop and smartphone responsive experience

## 1. Product goal

G-Rex Agent Control must become a real **AI agent control room** that
can be operated without VS Code.

The interface must answer immediately:

1.  What is working?
2.  What is stopped or failing?
3.  Where is human intervention required?
4.  What has been completed and needs verification?
5.  What is it costing?
6.  Is the system healthy enough to continue autonomously?

The UI must reduce operator cognitive load. Information that does not
require attention should remain visible but quiet. Anything requiring a
human decision must become prominent.

## 2. Fundamental responsive principle

Do **not** design one vertical mobile layout and stretch it across
desktop.

The application has one information architecture but two different
compositions.

### Desktop

Desktop is for **supervision and simultaneous control**: - fixed
sidebar; - wide workspace; - grids and compact operational tables; -
multiple information areas visible simultaneously; - optional contextual
right drawer; - high information density without visual clutter.

### Smartphone

Smartphone is for **rapid intervention, monitoring and decisions**: -
single-column priority flow; - large touch targets; - human requests
before passive monitoring information; - compact summaries; - bottom
navigation; - drill-down for technical details.

The smartphone version must remain essential but complete.

## 3. Core hierarchy

**Control Room → Project → Objective → Session → Execution Attempt**

-   **Control Room:** overall operational situation.
-   **Project:** state and workload of one product/repository.
-   **Objective:** what the operator asked G-Rex to achieve.
-   **Session:** the agent's working lifecycle.
-   **Execution Attempt:** individual technical execution through a
    runtime/provider/model.

Most normal operation should happen at the first three levels.

## 4. Navigation

### Desktop sidebar

Primary: - Control Room - Projects - Objectives - Executions - Requires
You

Secondary: - Governance - AI Catalog - Events / Audit - System -
Settings

### Smartphone bottom navigation

-   Control
-   Projects
-   Executions
-   Requires You
-   More

`More` contains Governance, AI Catalog, Events/Audit, System and
Settings.

`Requires You` must support a pending-count badge.

# 5. Control Room

The Control Room is an operational cockpit, not an administration page.

It must answer: **What is working? What is waiting? What needs me? What
is failing?**

### Desktop

Use three principal areas: 1. left navigation; 2. central operational
workspace; 3. right-side `Requires your intervention` area.

``` text
┌─────────────────────────────────────────────────────────────────────────────┐
│ G-REX CONTROL ROOM                    System ● OK       € today        User │
├───────────────┬──────────────────────────────────────────────┬──────────────┤
│ CONTROL ROOM  │ ACTIVE  WAITING  ERRORS  NEED YOU            │ NEEDS YOU    │
│ Projects      ├──────────────────────────────────────────────┤ Approval     │
│ Objectives    │              WORK IN PROGRESS                │ requested    │
│ Executions    │ Project   Objective   AI   Time   Cost       │ [Approve]    │
│ Requires You  │                                              │ [Reject]     │
│ Governance    ├──────────────────────────────────────────────┤──────────────│
│ AI Catalog    │ PROJECTS              RECENT RESULTS         │ TO VERIFY    │
│ Events        │                                              │ [Open]       │
│ System        │                                              │              │
└───────────────┴──────────────────────────────────────────────┴──────────────┘
```

Keep top indicators compact:
`4 Active · 1 Waiting · 1 Error · 2 Need You · €2.84 today`

Also expose concise availability:
`Agent Control ● · Cline ● · Codex ● · OpenRouter ●`

Prefer compact operational rows over large cards.

### Smartphone

Priority: 1. system/notification header; 2. Requires You; 3. active
work; 4. recent completions; 5. secondary information.

Human intervention always rises above passive monitoring.

# 6. Project

A project page combines: - operational status; - active objectives; -
items awaiting human action; - backlog; - recent results; - project
health; - cost/budget.

Desktop should use compact objective rows/tables. Smartphone should show
Requires You, In Progress, To Verify, Next and a compact health summary.

The project must expose a real backlog with explicit priority, state and
dependencies where relevant.

# 7. Create Objective

Default creation must be simple.

``` text
NEW OBJECTIVE

Project
G-Rex Clienti

What must be achieved?

[ Natural-language objective description ]

Execution

● Automatic recommended
  G-Rex chooses runtime/provider/model

○ I choose manually

Policy
✓ Respect project budget
✓ Ask approval for sensitive actions
✓ Verify result before completion

[ START OBJECTIVE ]
```

Do not expose provider/model/token/fallback complexity by default.
Manual selection belongs under an advanced path.

# 8. Objective

The Objective page connects **what the operator requested** to **what
G-Rex did to achieve it**.

### In progress

Show: - title and description; - state and elapsed time; - meaningful
current activity; - plan/progress; - active session; - selected AI and
routing reason; - runtime approval if required; - modifications so
far; - consumption; - recent events.

Routing explanation should be human-readable: suitability, reliability,
cost and budget compatibility.

### Completed

When work completes, result and verification become primary.

Order: 1. result summary; 2. independent verification; 3. final agent
report; 4. modifications/diff; 5. execution history; 6. final human
decision.

Actions: - Approve result - Request changes - Reject

Request Changes accepts natural-language feedback and preserves
objective genealogy.

On smartphone, a user must be able to receive a completion notification,
understand the result and decide without opening VS Code.

# 9. Session

Session is the operational/technical view while an agent works.

Desktop may expose timeline, current activity, attempts, events/log and
metrics simultaneously.

When completed, the final agent report must be clearly visible inside
Agent Control.

Smartphone priority: - state; - objective; - AI; - cost/tokens; - human
intervention; - current activity; - plan; - attempts; - modified
files; - recent events; - stop.

Raw logs must not dominate.

# 10. Requires You

This is the human inbox. It contains **only things waiting for a human
decision**.

Categories: - Runtime approvals - Blocked executions - Completed results
awaiting verification - Governance/budget decisions

Runtime approval and final result approval are different concepts and
must look different.

### Runtime approval

Show: - project/objective/session; - requested action; - impact; -
risk; - why approval is required; - relevant policy; - agent context.

Actions: - Approve - Reject - Ask for alternative - Details

Approval defaults to the narrowest scope: **Approve once**.

### Completed work decision

Show verification, final report, modified files/diff, cost and: -
Approve - Request changes - Reject

### Empty state

`✓ No intervention required — Agents can continue autonomously.`

On smartphone, notifications should deep-link directly to the relevant
decision.

# 11. Executions

Executions is the **Task Manager for agents**.

It shows who is working, on what, through which AI, duration, cost,
queue, retry/fallback and human waits.

Desktop active executions should be a dense table. Clicking a row should
preferably open a contextual drawer.

Expose: - Active - Queue - Retry - Waiting - Blocked

### Capacity

Show concurrency understandably, e.g. `3 / 4 workers occupied`.

### Retry/fallback

Do not expose only technical state names. Explain what failed, what
happens next and why.

### Waiting for operator

A session awaiting approval must be visibly waiting, not appear normally
active.

### Stop

Explain the consequence: - stop current execution but keep objective
available; - stop and cancel objective.

Do not show Pause unless real suspend/resume exists.

Smartphone order: 1. Requires You 2. Active 3. Retry 4. Queue

# 12. System

System answers: **Is Agent Control actually able to work autonomously
right now?**

Use one high-level readiness state:

-   **Ready to work**
-   **Limited operation**
-   **Not ready**

Show health for: - Control Plane; - worker; - database; - remote
network/Tailscale; - notifications; - backups; - Cline; - Codex; -
configured AI providers.

Also show active sessions, queued jobs, scheduled retries, stale
sessions and blocked executions.

### Doctor

Integrate human-readable diagnostics.

Bad: `spawn ENOENT`

Good: `Codex CLI is installed but authentication is invalid.`

Then provide a direct action.

Never display full secrets.

On smartphone, show operational impact before technical detail.

# 13. AI Catalog + Routing

The catalog must make routing intelligence understandable without
forcing manual model management.

Keep runtime, provider and model distinct.

Expose operational attributes: - availability; - capabilities; -
cost/pricing; - reliability; - optionally speed/performance.

Show useful historical signals: - selection frequency; - first-attempt
success; - average cost; - performance by objective/task class.

For a routing decision expose: - selected runtime/provider/model; -
compatibility; - reliability; - estimated cost; - budget; - historical
performance; - score/reason; - alternatives.

The operator should primarily control **rules**, not individual model
choices: - automatic governed routing; - respect budget; - prefer
reliability; - allow fallback; - use historical outcomes; - maximum
cost; - minimum reliability.

Avoid temperature, raw context windows, CLI flags and provider-specific
internals in the main view.

# 14. Governance

Dedicated advanced area for: - project/objective budgets; -
warning/hard-stop/approval policies; - active exceptions; - exception
expiry/revocation; - routing policies; - capability/security rules when
available; - policy audit.

Changes must be auditable.

# 15. Events / Audit

Complete technical/human history, not the main operational UI.

Support filters for project, objective, session, attempt, event type,
runtime/provider/model, human decisions and governance changes.

Prefer human-readable summaries with raw details on demand.

# 16. Settings

Settings contains actual configuration: - user/security; - notification
preferences; - data locations; - integrations; - advanced
runtime/provider configuration; - UI preferences.

Operational health belongs in System.

# 17. Visual language

Desired direction: - dark professional control-room aesthetic; - strong
information hierarchy; - compact but readable; - fewer nested cards; -
fewer borders; - more operational rows/tables on desktop; - useful
whitespace; - status chips; - drawers for contextual detail; -
responsive composition rather than scaled-down desktop.

Semantic color: - green: healthy/success/proceeding; - amber:
attention; - red: error/risk/human intervention; - blue: neutral
information/action.

Avoid: - card inside card inside card; - huge empty desktop areas; -
narrow vertical columns on wide screens; - tiny text caused by mobile
assumptions; - decorative dashboards with no operational value; - raw
internal enum/state names when human language is possible.

# 18. Interaction principles

Every alert must explain: - what happened; - what is affected; - why the
operator is needed; - what actions are available.

Use progressive disclosure: operational meaning first, technical details
via drawer/expand/details/audit.

Preserve context with drawers and inline expansion where appropriate.

On smartphone, human intervention always comes first.

# 19. Runtime approval vs final decision

This distinction is mandatory.

### Runtime approval

Occurs **during execution**.

Question: `May the agent perform this sensitive action?`

### Final decision

Occurs after result verification.

Question: `Do I accept the work produced for this objective?`

These flows require different labels, visual treatment, event types and
persistence semantics.

# 20. Final agent report

Core requirement:

**The final response produced by Cline/Codex must be available inside
Agent Control.**

It should be captured, normalized, persisted, associated with the
session/objective/checkpoint and clearly displayed.

The operator must not need VS Code to read the final agent result.

# 21. Responsive behavior

### Wide desktop

-   persistent sidebar;
-   multi-column/grid layout;
-   contextual right area/drawer;
-   operational tables.

### Narrow desktop/tablet

-   sidebar may collapse;
-   secondary columns may become drawers;
-   preserve horizontal density where useful.

### Smartphone

-   bottom navigation;
-   single-column priority layout;
-   no horizontal desktop tables;
-   large touch targets;
-   human requests first.

Do not solve responsiveness merely with `flex-direction: column`.

# 22. No fake capabilities

The UI must never imply a capability the backend cannot guarantee.

Examples: - no Pause if runtime resume is unsupported; - no successful
independent verification unless a verifier actually ran; - no runtime
approval controls until approval requests genuinely flow through Agent
Control; - no claim that CLI conversational/output streams resumed when
only PID supervision was reattached.

Unsupported designed capabilities must be recorded as implementation
gaps, not simulated.

# 23. Implementation strategy

Do not attempt the whole redesign in one uncontrolled change.

Recommended sequence:

1.  application shell, navigation and responsive foundations;
2.  Control Room;
3.  Project;
4.  Objective;
5.  Executions;
6.  Requires You;
7.  Session;
8.  System;
9.  AI Catalog / routing;
10. Governance, Events/Audit and Settings refinement.

For every phase: - preserve existing behavior; - reuse existing
APIs/domain; - identify backend gaps explicitly; - verify desktop and
smartphone; - run repository quality checks; - avoid unrelated backend
architecture changes.

# 24. Acceptance criteria

The redesign succeeds when:

1.  A 1920px desktop no longer looks like a narrow smartphone page
    centered in empty space.
2.  Desktop uses horizontal space to supervise multiple agents and
    states.
3.  Smartphone remains essential, readable and functionally complete.
4.  Human intervention is immediately visible.
5.  Runtime approvals and final decisions are unmistakably separate.
6.  Active work is understandable without raw logs.
7.  Completed work exposes verification, final report and decision
    clearly.
8.  Projects expose active objectives and backlog.
9.  Executions expose queue, retry/fallback and concurrency clearly.
10. System health explains operational impact, not only technical
    errors.
11. AI routing is explainable without forcing manual model management.
12. Advanced technical detail remains accessible without dominating
    normal use.
13. Existing working Agent Control capabilities are preserved.
14. Unsupported future capabilities are not simulated.
15. VS Code is not required for normal operational supervision or
    reading final agent results once the corresponding backend
    capability exists.

# 25. Product principle

The Control Room should make autonomous AI work feel **supervised,
understandable and governable**.

The operator spends attention on: - objectives; - exceptions; -
approvals; - verification; - decisions.

Agent Control absorbs: - runtime complexity; - provider/model
selection; - retry/fallback mechanics; - technical state; - routine
monitoring.

**Desktop = supervision and simultaneous control.**

**Smartphone = rapid intervention, monitoring and decision.**
