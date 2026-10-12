# Architecture and versioned contracts

## Decisions

- Approved repository: `/Users/ankojh/b12/observe`, cloned from `git@github.com:ankojh/observe.git` (empty initially).
- Chrome MV3 extension; the primary interface is a Chrome side panel, not a standalone website.
- Vite/React for the panel, esbuild for worker/content bundles, TypeScript, Dexie/IndexedDB, Zod. This keeps the suggested component boundaries without adding a monorepo framework.
- OpenAI via an authenticated Node/Express loopback backend, SQLite from Node's `node:sqlite` (experimental warning on Node 22 is expected). No deployment target or remote authentication is implemented.
- Provider model, credentials, terms, and cost limits are setup requirements, not silently selected defaults.
- Tests deferred by owner; build/type checks are not privacy/browser acceptance.

## Data flow

Approved page → isolated-world content script → serialized worker gate → IndexedDB → pure local sequence grouping → exact side-panel sharing preview → paired loopback API → OpenAI structured output → schema/grounding validation → persistent interpretation/corrections → portable draft → explicit reviewed file export.

Core logic imports no Chrome, DOM, or provider APIs. Only backend provider code contacts OpenAI. Content scripts cannot invoke a backend, change consent, or access pairing storage. All model strings render as text, not HTML. No generated code runs.

## Capture and lifecycle

The worker registers listeners synchronously. One promise lane serializes mutations, including consent changes, events, permission changes, boundaries, corrections, and reset. A pause acknowledgment follows the durable gate update. Epoch mismatches reject old buffered events, including after re-enable. Reset advances both the epoch and data generation.

Dynamic scripts persist across navigation/restart. Startup and permissions changes reconcile registrations against the local consent list and actual Chrome grants. Already-open scripts receive disabled/config messages; removing a registration alone is never trusted to stop capture. Scripts have an isolated-world singleton and start disabled until handshake. Injection is top-frame only.

Events are acknowledged only after storage commit; IDs and document/sequence pairs deduplicate retries. At most eight page messages may be in-flight with one idempotent retry while the same epoch is enabled. No offline upload backlog. Navigations/crashes can lose events; sequence gaps and delivery-limit boundaries are exposed where detectable. This is not perfect delivery.

SPA route detection compares location transiently every second only while a visible, enabled page is being observed, plus popstate/hash events. It stores only `page.route_change`, not routes or hashes. No page-world History API patch, worker keepalive timer, or webNavigation permission is used.

The worker computes receipt time and checks the sender's actual origin, top frame, incognito flag, current host grant, current epoch, and focused active tab/window. It never trusts a payload timestamp or host. Visible flags are hints from trusted capture code; browser foreground state is checked independently.

## Memory / migrations

Dexie schema v1 defines `events`, `episodes`, `workflows`, `feedback`, `definitions`, `aiJobs`, and `consents`. Origin/permission management stays local. Pairing token lives in `chrome.storage.local` with access restricted to `TRUSTED_CONTEXTS`. Future storage changes must add a Dexie version migration; never silently reinterpret schema v1 rows.

Default retention is seven days, editable 1–30 days; event cap is 10,000. Pruning runs on worker startup, commands, and committed events. There is no permanent retention timer in an MV3 worker. On the next wake, entire affected episodes and dependent claims/drafts/jobs are invalidated; surviving workflow counts are recomputed from remaining episode IDs. Retention is therefore enforced on use, not a guaranteed wall-clock erasure deadline while the browser is closed.

Write failure blocks capture, saves an emergency gate in trusted Chrome storage where possible, and pauses IndexedDB consent where writable. If neither store can persist a pause, the response explicitly instructs closing approved tabs/reset rather than promising durability. Failed ingestion never receives a successful commit acknowledgment. Quota/corrupt-storage recovery may require reset or extension reinstall.

## Episode and matching limits

A foreground stream can cross approved apps/tabs. Timing breaks are persisted on tab/window transitions to avoid attributing known hidden time even if the intervening app produces no event. No time is accumulated across tabs; same-tab event intervals are capped at 30 seconds. Idle over two minutes, explicit boundaries, pause, unobserved intervals, browser restart, and 120-event bounds close episodes. Timing remains approximate and may undercount work.

Episodes are non-overlapping. Completed episodes with at least two meaningful safe control/submit actions are eligible for deterministic grouping; unknown/navigation-only activity is insufficient. Weighted normalized edit distance compares at most 120 tokens per pair (O(120²)); meaningful actions weigh 1.5, navigation 0.6, unknowns 0.35. Threshold 0.76 is a heuristic. Matches must also share meaningful actions; app order alone cannot establish a pattern. A representative episode anchors each group and variants remain inspectable. This is conservative, not general process mining.

One occurrence is a candidate; two are emerging; three allow an analysis recommendation. No weekly frequency is inferred. Cards show occurrence count, timespan, approximate mean active time, last similarity score, and feasibility/blockers after interpretation. Priority is explicitly occurrences × mean approximate active time ÷ (1 + known capture gaps), with repetition as a tie-breaker; confirmed feasibility is not invented. Savings default to zero: manual time minus user-assumed remaining human review. No claimed connector availability or ROI.

Corrections are scoped to a workflow, persisted as versioned feedback, and included in later summaries and definitions for matched occurrences. Corrected rules retain superseded provenance but only current rules are applied. Exclusion removes an occurrence from counts while preserving inspectable activity. Dismissals suppress recommendations until restoration or three new occurrences. Corrections/exclusion invalidate drafts rather than overwrite human edits. Original interpretations retain up to ten archived versions with their evidence count, correction version, digest, and source text. Evidence deletion invalidates dependent archives; they are never displayed as current claims.

## AI jobs and grounding

API routes (our application endpoints):

- `GET /health`: authenticated readiness and retention.
- `POST /analysis-jobs` or `/definition-jobs`: strict `{requestId, kind, payload, approval:true}`.
- `GET /jobs/:id`: authenticated status/result for either kind.
- `DELETE /jobs/:id`: best-effort cancel and erase backend result.

All routes require bearer pairing authentication, exact loopback Host, and configured extension Origin when present. CORS allows only that origin; it is not authentication. Request limit 48 KiB, six new jobs/minute, at most six accepted concurrent/queued jobs, two provider calls at once, 60-second provider timeout, ten-second panel fetch timeout. Idempotency checks precede charging/rate controls. Reusing an ID with another payload is rejected. No automatic charged retries.

SQLite persists job IDs, kind, approved-payload digest, state, creation time, result/error, and daily estimated cost reservations. Approved input is only transient process memory. Interrupted queued/running jobs become failed on restart. Terminal results expire after 24 hours and hourly cleanup; cost reservations persist for up to three days. Failed/cancelled estimates are not refunded to avoid uncertain retries exceeding caps.

Local jobs retain the exact approved summary, its digest, an authoritative evidence snapshot digest, and data generation. Opening the panel recovers only previously approved work. Evidence change, correction, exclusion, deletion, or reset makes an old result invalid. Results are schema-validated twice and cannot overwrite code-computed counts/timing.

Evidence refs must belong to the submitted set. An `observed` model statement must exactly match a code-generated action statement for the cited occurrence (`Recorded category (action) in app-ref.`). A `user-confirmed` claim must quote a submitted correction exactly. Other interpretations are always inferred. Exact-ref validation cannot establish the truth of inferred business intent; users must review it. Draft confirmed rules must exactly match submitted rules; every capability is forced to `unverified`.

## Export schema 1.0

`packages/core/src/schemas.ts` is authoritative. `AgentDefinition` has version/id/status, goal/non-goals, typed input requirements, ordered semantic steps and earlier-step dependencies, unverified capabilities, source-tagged rules, outputs, success criteria, human approval boundaries, prohibited actions, questions, code-assigned provenance, and explicit savings assumptions. Unknown fields are rejected.

`reviewed_definition` requires no unresolved questions; it still does not mean deployed or executable. Editor saves advance versions, enforce immutable evidence provenance, and recompute assumed savings. JSON and Markdown are generated from the same validated object; Markdown includes the complete JSON for parity and escapes prose/HTML. Opaque references resolve only locally. There is no deployment adapter implementation; future adapters must separately validate capabilities and constraints.
