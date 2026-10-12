# Observe — Standalone MVP Builder Handoff

## 0. Read this first: authority and decisions

This document is a specification and implementation handoff, not an implementation. The owner explicitly requested: **do not build yet; create a handoff that can be passed to a builder agent.** Receiving this file alone does not authorize implementation. Begin when the owner instructs you to build.

### Confirmed product decisions

- Build a standalone, provider-independent browser workflow discovery product, working name **Observe**.
- Support **generic, explicitly user-approved websites**, not a product restricted to two instrumented demo applications.
- First milestone ends at **editable agent definitions and export** (versioned JSON and human-readable Markdown).
- **No agent execution, browser replay, autonomous actions, or CREAO integration** in this milestone.
- Richer workflow interpretation and agent-definition generation use **hosted AI through a secure backend**.
- Raw observations stay local; only user-reviewed, minimized summaries may be sent to hosted AI.
- CREAO may become a deployment adapter later. Its availability, event participation, and API must not determine this product's architecture.
- No existing repository or implementation directory has been selected. `~/observe` was proposed, but NOT approved: the owner requested this handoff instead.
- Hosted AI provider, model, deployment target, budget, and credentials have NOT been selected.

### Before coding, confirm only unresolved essentials

1. Implementation directory / existing repository.
2. Hosted AI provider and model, account availability, cost limit, and applicable data-handling terms.
3. Local-only single-user backend for development versus remotely deployed backend. Recommend a loopback-only backend first, with an authenticated hosted-AI proxy.

Do not ask the owner to decide routine internal implementation details that this handoff already resolves. Do not read credentials from unrelated projects. Never put provider secrets in extension code, extension storage, exported definitions, or browser-visible environment variables.

### Git and delegation

- Ask permission before committing or pushing.
- Commits must use Conventional Commits: `type(scope): description`.
- Author and committer: `ankojh <ankitkumarojha2@gmail.com>`.
- Before any push, verify the identity used by the actual push remote is GitHub account `ankojh`; Git author configuration is not proof. Stop and ask if identity cannot be verified.
- Do not invoke additional agents unless the owner's build request or applicable project instructions authorize delegation.

---

## 1. Product thesis and end-to-end outcome

Users often do not know what to automate. Observe helps them identify repeated work from privacy-minimized browser interaction sequences, correct the interpretation, and turn confirmed intent into a reusable automation definition.

**Observe → Remember → Recognize → Explain → Confirm → Define → Export**

The MVP should answer:

1. What activity did the extension actually observe?
2. What recurring sequence does the evidence support?
3. What might the user be trying to accomplish?
4. What did the user confirm or correct?
5. What information and capabilities would an agent need?
6. What remains unresolved before that agent could be deployed safely?

Do not promise that generic UI events reveal the user's business intent or that an exported definition is runnable. A useful output may be an incomplete draft with explicit questions.

### Product honesty

Every meaningful claim has a source category:

- **Observed:** a minimized, recorded browser event.
- **Inferred:** a heuristic or model interpretation, with evidence references and uncertainty.
- **User-confirmed:** a correction or rule explicitly supplied by the user.

Examples:

- A click on a safely classified `save` control is observed.
- "Customer record updated successfully" is NOT established merely by that click.
- Opening an inbox route does not prove an email was read.
- Browsing two applications does not prove information was copied between them.
- Similarity scores are heuristic scores, not calibrated probabilities.

---

## 2. Scope

### Must have

1. Chrome Manifest V3 extension installed unpacked.
2. Chrome side panel as primary UI.
3. Explicit per-site permission grant and visible observation status.
4. Start/pause, revoke site, inspect observations, delete local data.
5. Privacy-minimized navigation, safe click-category, and submit-event capture.
6. Persistent local memory across side-panel closure, worker termination, and browser restart.
7. Cross-tab episode construction within a bounded foreground activity stream.
8. Similarity-based grouping across distinct episodes, tolerating small variations.
9. Evidence-backed repetition counts and approximate active durations.
10. User-approved hosted-AI interpretation through an authenticated backend.
11. Corrections that persist and affect subsequent interpretations and definitions.
12. Editable agent definition with missing-information questions.
13. JSON and Markdown export, without execution.
14. Repeatable test/demo flow based on actual recorded browser events.

### Explicitly out of scope

- CREAO endpoints or credentials.
- Any production deployment adapter.
- Agent execution, generated-code execution, browser automation, or replay.
- Arbitrary-page DOM scraping, screenshots, screen recording, clipboard reading, network payload interception, raw keylogging.
- Collection of field values, email contents, payment data, passwords, or page text dumps.
- Native desktop monitoring.
- Fine-tuning, vector databases, cloud storage of event streams, complex process-mining infrastructure.
- Team analytics, billing, production multi-tenancy, Chrome Web Store publishing.
- Full support for iframes, closed shadow roots, canvas interfaces, privileged Chrome pages, incognito, or every SPA interaction.

### Generic capture does not mean universal understanding

Use generic capture on arbitrary approved HTTP(S) hosts, with graceful degradation. Supported safe controls can be classified; unknown controls remain unknown. A later site adapter can improve semantic classification without changing learning or export interfaces.

Controlled sites are allowed as test fixtures, NOT as the only supported observation mechanism. Do not depend on `data-observe-*` attributes in the core product.

---

## 3. Component architecture

```text
Approved HTTP(S) pages
    |
    v
OBSERVATION ENGINE (extension content scripts)
  consent-aware listeners, safe event classification, minimization
    |
    v
Extension service worker
  sender validation, consent gate, dedupe, durable writes
    |
    v
IndexedDB (extension origin)
    |
    v
LEARNING ENGINE (pure TypeScript + persisted state)
  activity normalization, episode segmentation, similarity matching,
  recurrence evidence, feedback application
    |
    v
Side panel: inspect candidate + approve exact outbound summary
    |
    v
Authenticated backend -> hosted AI provider
  schema validation, prompt construction, provider adapter,
  timeouts, cost/rate controls, no raw event ingestion
    |
    v
Validated interpretation + user corrections
    |
    v
AGENT DEFINITION ENGINE
  portable definition, unresolved questions, capability requirements
    |
    v
JSON / Markdown export
    |
    +--> Future deployment adapters (not implemented)
```

Keep these as modules, not microservices. A single extension and a small backend are sufficient.

### Interface boundaries

- Observation emits provider-independent `ObservedEvent` records.
- Learning accepts those records without importing `chrome.*`, DOM APIs, or provider SDKs.
- Backend interpretation accepts a `WorkflowSummary`, never arbitrary raw observations or DOM snapshots.
- Definition generation returns a versioned `AgentDefinition`, not a CREAO request or executable script.
- Future adapters map definitions into supported runtime capabilities and explicitly reject unsupported requirements.

### Suggested stack

- WXT + TypeScript + React for Manifest V3 extension and side panel.
- Tailwind or simple CSS; minimal visual system rather than a dashboard library.
- Dexie over IndexedDB for transactional memory and indexes.
- `chrome.storage.local` for small settings/consent state; restrict sensitive configuration to trusted extension contexts where appropriate.
- Node.js + Express for the backend, unless the selected repository already supplies an equivalent lightweight server.
- Zod for shared request, response, and export validation.
- Vitest for pure logic and schema/privacy tests.
- Playwright persistent Chromium context for extension smoke tests where supported; supplement with documented manual Chrome checks.
- Native fetch or the selected provider's official SDK. No orchestration framework required.

Do not add Next.js solely to host three API routes. Do not add a vector store or embeddings to the first milestone.

---

## 4. Observation and privacy design

### Permission model

- Start with observation disabled.
- Grant host access only through an explicit user gesture.
- For arbitrary sites, the manifest may need broad **optional** HTTP(S) host patterns to permit later narrow requests. Explain this distinction: declaring optional capability is not granting access to all sites.
- Request a specific scheme/host match pattern at runtime; display the actual scope. Do not silently request wildcard subdomains.
- Avoid required `<all_urls>`, `history`, `debugger`, clipboard, screen-capture, cookies, or web-request permissions.
- Base permissions should be limited to what is necessary, likely `sidePanel`, `storage`, `scripting`, and `activeTab`; justify any addition.
- `activeTab` alone is not sufficient for durable observation across authorized navigation; use explicit optional host grants.
- Dynamically register content scripts for approved hosts. Reconcile registrations against consent on startup and permission changes.
- Treat Chrome permission grants and the extension's own enabled-site list as separate checks; both must permit capture.
- Restrict backend cross-origin access to the configured endpoint. Account for its permission separately from observed-site consent.

### Safe event vocabulary

Examples of event categories:

- `page.enter`
- `page.route_change`
- `control.activate` with a safe action category such as `search`, `save`, `edit`, `next`, `back`, `reply`, or `unknown`
- `form.submit_attempt`
- `page.visibility_change`

A submit event means an attempt, not a confirmed successful server operation. Generic capture cannot reliably detect every JS-only form flow; disclose coverage.

### Collection minimization before persistence

Allowed baseline fields:

- Generated event ID and document sequence number.
- Timestamp.
- Local site reference and tab/document reference.
- Event category.
- Coarse element role, if useful.
- Fixed safe action category, not raw text.
- Optional safe route category, when conservatively recognized.

Never persist or transmit:

- Input/textarea/contenteditable values; field content on submit.
- Keypress streams or clipboard content.
- Email subject/body text or surrounding DOM text.
- Raw accessibility labels, button labels, text content, element IDs, selectors, or form action URLs.
- Full URLs, query parameters, fragments, arbitrary path segments, page titles, or referrers.
- Screenshots, cookies, request/response bodies, or credentials.

For generic control classification, inspect only the candidate control's bounded label when necessary to compare against a fixed exact allowlist; emit the enum and discard the source label immediately. Do not traverse parent containers or capture nearby prose. If classification is uncertain, emit `unknown`. Do not extract any text/value from editable controls. Denylisted sensitive control types are ignored entirely.

The host itself can reveal private organizational information. Keep actual approved hosts local for permission management. Outbound summaries default to user-reviewed aliases such as `App A` and `App B`; user-supplied app names require preview before sharing.

For route changes, compare locations transiently if needed, but persist only a safe category or generic change event. Do not hash raw sensitive URLs and call them anonymous. Prefer losing specificity to retaining identifying routes.

### Generic SPA capture

- Standard navigation: content-script initialization after page/document load.
- Back/forward/hash navigation: suitable browser/page events.
- `pushState`/`replaceState`: select and document a minimally privileged mechanism. A bounded, visible-page-only location comparison can be acceptable for MVP; avoid permanent worker timers or broad `webNavigation` access merely for convenience.
- Debounce route transitions and deduplicate repeated initialization.
- Cross-origin frames and unsupported surfaces are excluded, not silently represented as fully observed.

### Consent gate and immediate pause

- Content scripts default to disabled until current consent is known.
- Worker validates sender identity, actual sender URL/host, top-frame scope, message schema, and current permission/consent before accepting an event.
- Never trust a host or timestamp supplied only by message payload.
- Pause updates durable state, broadcasts shutdown to scripts, and blocks new writes.
- Use a consent epoch/generation to reject buffered events from an earlier enabled period after pause, revoke, or reset.
- Unregister scripts on revocation, but do not assume unregistering removes listeners from already-open pages; explicitly disable them and enforce the ingestion gate.
- Define pause success as the point the worker acknowledges the new gate. No subsequently arriving stale event may be committed after that acknowledgment.
- Do not queue an offline backlog for later upload after consent is revoked.

### Worker reliability

Manifest V3 workers are ephemeral. Register listeners synchronously at startup, persist state, and avoid in-memory-only event queues or session counters.

Use transactionally persisted event IDs and deduplication. Acknowledge an event only after commit. Bound retries; expose capture gaps rather than promising perfect delivery during navigation/crashes. Do not keep the worker alive artificially.

For AI work, persist the job ID and recover status when the panel reopens. Do not require a long-lived service-worker fetch for inference to finish.

---

## 5. Memory and episode model

Store memory under the extension origin, NOT in a website's IndexedDB.

### Suggested stores

| Store | Key contents |
|---|---|
| `events` | ID, document sequence, time, local site ID, safe category/action, consent epoch |
| `episodes` | Event IDs, boundaries, boundary reasons, start/end, duration estimate, capture gaps |
| `workflows` | Stable ID, representative episode, variants, occurrence IDs, heuristic scores, interpretation versions |
| `feedback` | Workflow ID, correction type, corrected intent/rules, timestamp, version |
| `opportunities` | Workflow ID, factual evidence, feasibility factors, savings assumptions, review state |
| `definitions` | Versioned portable definitions, evidence provenance, user edits, unresolved questions |
| `aiJobs` | Local job ID, approved-payload hash, backend job reference, status, response version |
| `consents` | Approved sites, observation state, epoch, per-request sharing approval metadata |

Index timestamps, episode/workflow IDs, and job status as needed. Use schema migrations and transactional updates.

### Session and episode management

A browser session is not the same as a workflow occurrence.

- Use one bounded foreground activity stream across approved tabs/windows.
- Preserve application transitions, without inventing actions on unapproved sites.
- Long inactivity, pause, an unobserved interval, or an explicit user boundary can split episodes.
- Do not naively concatenate activity from concurrent background tabs.
- Let users mark an episode complete or adjust a boundary when automatic segmentation is uncertain.
- Repeated tasks performed inside one long browsing session must be separable; support explicit boundary markers in the MVP rather than pretending inactivity alone solves segmentation.
- Never rely on a hardcoded inbox-to-CRM sequence as the segmentation rule.

Estimate active duration only for a focused, visible approved page, with capped inactivity intervals. Exclude known hidden/unfocused time and do not double-count tabs. When exact foreground state cannot be established, label timing as approximate and lower confidence.

Retention: choose a bounded default (for example, seven days or a documented event cap). Handle quota/write failures visibly. Deleting evidence must invalidate or recompute related counts, candidates, and summaries; do not preserve unsupported evidence claims.

Reset must pause capture, advance consent/data generation, cancel/invalidate outstanding local jobs, and clear events plus derived local memory. Late AI responses must not repopulate deleted data. Retaining site permissions after reset should be an explicit option, not silently restarting observation.

---

## 6. Learning and opportunity discovery

### A. Normalize actions

Map safe events into application/action tokens, collapse duplicate noise, and preserve useful ordering. Unknown events remain unknown rather than being assigned invented semantics.

Example, illustrative only:

```text
App A: page.enter
App A: control.activate(open)
App B: page.enter
App B: control.activate(search)
App B: control.activate(edit)
App B: control.activate(save)
App A: control.activate(reply)
```

### B. Compare distinct episodes

Implement normalized edit distance or LCS-based sequence similarity in pure TypeScript.

- Allow inserted/omitted low-information actions.
- Weight meaningful action and application transitions more than generic clicks.
- Compare bounded-size episodes; document runtime limits.
- Keep representative episodes and observed variants instead of a single rigid template.
- Use thresholds as tunable heuristics, not probability claims.
- Do not infer a workflow from site order alone.
- Do not count overlapping candidate windows or duplicate events as separate repetitions.

A simple medoid/representative sequence per group is sufficient. Avoid clustering infrastructure.

### C. Accumulate evidence incrementally

Suggested states:

- One occurrence: candidate.
- Two sufficiently similar occurrences: emerging pattern.
- Three distinct occurrences: eligible to recommend analysis.

Three occurrences are an MVP product threshold, not proof of a durable routine. Display sample size and observed time span.

### D. Hosted interpretation after approval

Build a minimized summary containing:

- App aliases, normalized action sequences, and variations.
- Occurrence count and duration statistics computed in code.
- Locally resolvable opaque evidence references.
- Existing user-confirmed intent and rules relevant to this workflow.
- Capture limitations and known missing information.

The user reviews the exact outbound data and approves that payload/version. Editing it invalidates the previous approval. Reanalysis after correction or new evidence requires fresh approval in this MVP.

Require a structured response containing:

- Proposed workflow name and purpose.
- Observed versus inferred claims.
- Evidence references for claims, validated against the submitted evidence set.
- Alternative interpretations where appropriate.
- Questions needed to establish business rules.
- Proposed automation boundary and capability requirements.
- Feasibility explanation and blockers.

Counts and timing are authoritative code-computed fields; the model must not overwrite them. Reject malformed, unsupported, or ungrounded output. Render model text safely; never execute generated code or render unsanitized HTML.

### E. Learn from feedback

At minimum support:

- Correct workflow intent/name.
- Add or correct a business rule.
- Dismiss a recommendation.
- Mark a grouped occurrence as unrelated or wrong (a basic exclusion is sufficient).

Persist corrections as versioned user-confirmed constraints. Apply them to later matching occurrences and definition generation, not merely as a renamed UI card. Preserve evidence and original interpretation provenance.

If similar-looking actions may represent multiple goals, ask rather than applying a correction across every workflow with the same apps. Dismissal should suppress repeated identical recommendations until materially new evidence appears or the user restores it.

### F. Prioritization and savings

Prioritize using transparent factors: observed repetition, estimated active time, evidence quality, and confirmed feasibility.

Example:

`estimated savings per occurrence = max(0, estimated active manual time - assumed remaining human review time)`

Show the assumptions. Do not infer weekly frequency from a few staged observations. Weekly projections require a user-provided frequency and must be labeled projections. Capability availability is unknown until an eventual deployment adapter validates it.

---

## 7. Hosted AI backend

### Provider abstraction

Use an interface equivalent to:

```typescript
interface WorkflowInterpreter {
  interpret(summary: ApprovedWorkflowSummary): Promise<WorkflowInterpretation>;
  draftDefinition(input: ApprovedDefinitionInput): Promise<AgentDefinitionDraft>;
}
```

Implement only the selected provider initially. Keep provider configuration server-side. Do not assume every provider offers compatible endpoints or equally strict structured output.

A fake provider is acceptable for tests/development ONLY if clearly marked. Never present a fixture response as a live AI interpretation.

### Proposed application API (our routes, NOT provider endpoints)

- `POST /analysis-jobs`: validate an approved summary, start analysis, return job ID promptly.
- `GET /analysis-jobs/:id`: authenticated status/result retrieval.
- `POST /definition-jobs`: generate a draft from approved evidence, interpretation, and corrections.
- Optional analogous status/cancel endpoint using the same small job abstraction.

A simple persisted job table (e.g. SQLite) is adequate. Bound concurrency; a job interrupted by server restart must become a visible recoverable failure, not remain running forever. Avoid a separate queue service.

### Security and reliability

- Authenticate extension-to-backend requests. CORS is not authentication.
- For a loopback development server: bind loopback only, validate Host/Origin where applicable, use a random pairing token, and do not trust arbitrary websites on localhost.
- For a remotely deployed server: require TLS, session authentication, request authorization, payload limits, rate limits, and budget controls before exposure.
- Validate schemas both outbound and inbound.
- Never accept arbitrary provider URLs, shell commands, or requested tools from model output or page metadata.
- Treat observations, user-supplied labels, and corrections as untrusted data in prompts. No tool access is needed for interpretation or definition generation.
- Use request IDs/idempotency to avoid duplicate charged analyses on double-click or retry.
- Apply finite timeouts, bounded backoff, and explicit handling for auth errors, rate limits, provider failures, and invalid JSON.
- Do not log full payloads, corrections, tokens, or provider responses by default.
- Minimize backend retention and clean up temporary job payloads/results. Document what the hosted provider may retain under the selected account terms.
- Cancel local jobs and ignore late results on deletion. Do not promise that local deletion erases prior provider retention.

Even minimized workflow summaries and user-entered corrections can be sensitive. Redaction plus preview reduces exposure; it is not a guarantee of anonymity.

---

## 8. Portable agent definition

An **agent definition** is a declarative specification, not an executable agent and not a standardized interchange format guaranteed to work across vendors.

### Required structure

- `schemaVersion`, local ID, title, description, definition version.
- Status such as `draft`, `needs_clarification`, or `reviewed_definition` (never `deployed`).
- Goal and explicit non-goals.
- Inputs with types and required/optional flags; no observed field values embedded by default.
- Ordered semantic steps with dependencies where needed.
- Abstract required capabilities, each with support status `unverified` until an adapter checks it.
- Business rules tagged as user-confirmed versus proposed.
- Expected outputs and success criteria.
- Approval requirements and prohibited actions.
- Missing information / unresolved questions.
- Provenance: workflow ID, opaque occurrence references, factual counts, interpretation version, feedback version.
- Savings assumptions if included.

Example capabilities: `customer.lookup`, `record.propose_update`, `message.draft`. These are proposed needs, NOT proof that a connector exists.

Do not export CSS selectors, page scripts, actual credentials, OAuth tokens, raw browsing history, or hardcoded CREAO fields. Local evidence references may not resolve outside this installation; say so in the export.

### Definition review

- Let users edit the goal, input requirements, steps, rules, and unanswered questions.
- Export incomplete drafts with conspicuous unresolved-question markers rather than fabricating missing rules.
- Validate JSON against the versioned schema before export.
- Generate Markdown from the same validated object; both formats must agree.
- Export requires an explicit user action and a final privacy preview.
- Exports are files outside extension storage; local reset cannot recall them. Explain this.

### Future adapter seam (design only)

```typescript
interface DeploymentAdapter {
  validate(definition: AgentDefinition): CapabilityReport;
  // Future implementation requires separate deployment approval.
}
```

Do not implement provider-specific creation/execution now. A future adapter must distinguish supported, unsupported, and configuration-required capabilities, and must not silently drop constraints.

---

## 9. Side-panel UX

Keep one compact interface with a persistent status header and at most three primary sections:

1. **Activity**: observation controls, approved sites, inspectable timeline, episode boundaries.
2. **Patterns**: candidates, variants, evidence, interpretations, corrections, dismissals.
3. **Agent drafts**: definitions, unresolved questions, edit/review/export.

Settings can be a small secondary panel for site permissions, retention, backend pairing, and delete/reset.

### Key UI states

- Observation off / enabled but current site unapproved / actively observing / paused.
- Pattern collecting evidence / ready to analyze / awaiting sharing approval.
- AI pending / running / succeeded / failed / invalid result.
- Inferred interpretation / user-confirmed correction.
- Draft incomplete / reviewed definition / exported.

The badge/side-panel status must reflect actual collection state, not merely whether the global toggle is on. Never display fake "AI learning" activity when only deterministic local matching is running.

The sharing screen must preview all outbound content, including any stored corrections. Creation of a local draft, sharing with AI, export, and any future deployment are distinct actions.

---

## 10. Suggested project organization

Adapt to the approved repository rather than creating a complex monorepo framework.

```text
observe/
  apps/
    extension/
      entrypoints/           # worker, content script, side panel
      src/observation/
      src/storage/
      src/ui/
    backend/
      src/auth/
      src/jobs/
      src/providers/
  packages/
    core/
      src/schemas/
      src/learning/
      src/definitions/
      src/privacy/
  tests/
    fixtures/                # ordinary synthetic pages, no special capture hooks
    e2e/
  docs/
    architecture.md
    privacy.md
    demo.md
```

Pure core logic must remain independently testable without Chrome, a network, or API credentials.

---

## 11. Build order, dependencies, and acceptance gates

Do not polish the interface before capture, privacy, persistence, and export work.

| Task | Dependencies | Acceptance gate |
|---|---|---|
| T0: Confirm repository/provider/backend scope | Owner build approval | Decisions recorded; no unapproved credentials, spend, commits, or pushes |
| T1: Shared schemas and privacy vocabulary | T0 | Reject unknown/disallowed payload fields; observed/inferred/confirmed distinctions represented |
| T2: Extension shell and consent | T1 | Unpacked install, side panel, narrow site grant, accurate status, pause/revoke |
| T3: Generic capture | T2 | Ordinary synthetic pages and approved real-site smoke check produce minimized events without custom attributes |
| T4: Durable storage and timeline | T1, T3 | Worker/browser restart preserves data; dedupe, visible quota failures, inspect/delete work |
| T5: Episodes and similarity grouping | T4 | Exact repeat and small variant group; unrelated sequence rejected; distinct counts correct |
| T6: Backend/provider adapter | T0, T1 | Authenticated bounded live call succeeds; fake provider confined to labeled development/test mode |
| T7: Sharing review and AI interpretation | T5, T6 | Zero uploads before approval; exact payload preview; valid grounded result or explicit failure |
| T8: Feedback and incremental reuse | T5, T7 | Correction persists and applies to held-out matching occurrence; wrong-match exclusion works |
| T9: Definition generation and export | T1, T7, T8 | Valid editable JSON/Markdown; unresolved rules exposed; no execution claims or secrets |
| T10: End-to-end hardening and demo | All | Two successful reset-to-export runs; privacy/restart/failure/race tests pass |

T6 can be developed independently of browser capture after schema agreement. All integration paths must converge on shared validated types.

If time runs short, cut charts, custom visualizations, nuanced feasibility scoring, and automatic boundary refinement. Do NOT cut consent enforcement, local minimization, evidence provenance, correction persistence, or truthful export labeling.

The earlier one-day aspiration is not a delivery guarantee. Generic capture plus a hosted backend is broader than a two-app demonstration. Build in gated milestones and report scope honestly rather than faking completion.

---

## 12. Testing strategy

### Unit tests

- Privacy classifier: allowed static labels become enums; arbitrary text does not persist.
- Sensitive inputs and contenteditable controls are ignored.
- Query/path/title/selector/ARIA secrets never appear in serialized events.
- Event schema rejects extra fields.
- Duplicate ingestion is idempotent.
- Episode splits, inactivity caps, foreground timing, explicit boundaries.
- Similarity: exact match, inserted step, optional omission, reordered meaningful steps, unrelated sequence.
- No double counting from overlaps or retries.
- Correction application scoped to the intended workflow.
- Definition validation and consistent Markdown generation.
- Delete/reset invalidates derived records and late job responses.

### Browser/integration tests

1. No permission: zero capture.
2. Approved host: expected generic events appear.
3. Another host: no events, no stored URL metadata.
4. Pause then click/navigate/submit: no new accepted events after pause acknowledgement.
5. Revoke while page remains open: listeners disabled; ingestion gate rejects stale messages.
6. Full navigation and SPA route changes: captured without retaining sensitive locations.
7. Close/reopen panel and terminate/restart worker: no loss of committed data or duplicate counts.
8. Refresh content scripts: no duplicate listener registration.
9. Send malformed/spoofed messages: rejected.
10. Delete during an in-flight analysis: no resurrection of memory.

### Privacy canaries

Use unique fake secrets in:

- Password, email, payment, search, textarea, and contenteditable fields.
- Email-like subjects and bodies.
- Page title, URL query, fragment, and path segments.
- ARIA labels, element IDs, and nearby DOM text.

Search IndexedDB, extension storage, backend requests/logs, AI payloads, and exports for these canaries. None should appear unless a particular value was deliberately supplied by the user in a reviewed summary; test that exception separately and label it clearly.

### Hosted AI tests

- No outbound requests before explicit approval.
- Authentication, unauthorized job lookup, size limits, rate limits, duplicate requests.
- Provider timeout, invalid credentials, exhausted credits, malformed JSON, hallucinated evidence references.
- Prompt-injection strings in user-controlled labels/corrections cannot grant tools, change endpoints, or bypass constraints.
- Model result cannot inflate counts/durations or mark capabilities as verified.
- All model-generated text is safely rendered.

### Meaningful learning acceptance

Given three related episodes, including one variation, plus an unrelated episode:

- Related episodes group into one candidate with correct count and evidence.
- Unrelated episode does not join.
- User correction changes the intent/rule record.
- A held-out related episode inherits that correction.
- The resulting agent definition includes the correction and preserves unanswered questions.

---

## 13. Demo script

Use a clean Chrome profile and synthetic data; do not use private inboxes or production customer information.

1. Install the unpacked extension.
2. Approve two ordinary test websites separately and start observation.
3. Perform a short workflow across both sites.
4. End the episode explicitly if automatic boundaries are ambiguous.
5. Repeat twice, adding a harmless step in one occurrence.
6. Perform an unrelated short episode to demonstrate negative matching.
7. Inspect the real event timeline and pattern evidence.
8. Preview the outbound summary; approve hosted analysis.
9. Correct the interpretation (e.g. "This is lead qualification, not a general record update").
10. Record a related occurrence and show the correction being reused.
11. Add missing business rules or leave clearly marked questions.
12. Approve any additional AI request needed to generate the definition.
13. Review and export JSON and Markdown.
14. Open the exported definition; state explicitly that it is not deployed or executable yet.
15. Pause and reset; demonstrate that local observations and derived memory are gone.

Fixtures should use ordinary HTML controls and routes, not extension-specific workflow IDs. Prewritten recommendations and fake counts are prohibited. Test fixtures may contain synthetic data; all demo recommendations must derive from actual captured episodes and approved analysis.

---

## 14. Risks and fallback behavior

| Risk | Response |
|---|---|
| Safe generic metadata lacks enough meaning | Ask user to label the purpose and business rules; show insufficient evidence rather than scrape more content |
| Unknown controls / unsupported interfaces | Keep unknown categories and disclose coverage limits |
| Episode segmentation ambiguity | Explicit boundary controls and occurrence exclusion |
| Visually similar workflows have different goals | Preserve alternatives, ask for confirmation, scope corrections narrowly |
| Hosted AI unavailable | Capture/matching/inspection/manual definition editing still work; show failure, not fabricated AI output |
| Backend restart or worker termination | Persist job/event identity; resume status or mark recoverable failure |
| Provider cost grows | Analyze on approved demand, summarize bounded evidence, dedupe by approved payload/version |
| Agent definition implies capabilities that do not exist | Mark requirements unverified; leave deployment validation to future adapters |
| Sensitive data in user corrections | Preview, allow editing/redaction, explain hosted-provider exposure |
| Local deletion confused with cloud deletion | Explicit retention disclosure and deletion scope; no unsupported guarantees |

A manual definition editor is a useful resilience path, not a replacement for delivering the selected hosted-AI feature. Report which path was used in each demonstration.

---

## 15. Research context and future CREAO integration

The project started as "CREAO Observe" but is now intentionally standalone.

- CREAO already documents conversation-based Memory and Playbooks, reusable agents, dynamic workflows, and hosted Browser Use.
- Public documentation reviewed did not establish a CREAO product that passively discovers workflows from ordinary user activity across a local browser. This is not proof that no internal project exists.
- Bardeen describes a very similar observe → understand → automate concept. Do not claim the category is novel.
- Position Observe around transparent evidence, conservative capture, corrective feedback, and portable definitions.
- The linked event describes a four-hour company-assigned competition with CREAO in the Product Track, not necessarily an open-ended build-anything hackathon. This standalone project must remain useful regardless of the event brief.

### References (re-check before relying on mutable API/product contracts)

- Event: https://luma.com/yjt7f4ty?tk=kw2tqw
- CREAO memory/playbooks: https://docs.creao.ai/features/memory
- CREAO agents: https://docs.creao.ai/features/agents
- CREAO browser use: https://docs.creao.ai/features/browser-use
- CREAO API overview: https://docs.creao.ai/developer-api/overview
- CREAO creation/run flow: https://docs.creao.ai/developer-api/quickstart
- Bardeen Synthesis: https://www.bardeen.ai/posts/automating-automation-an-ai-agent-that-automates-enterprise-workflows
- Bardeen Automation Assistant: https://www.bardeen.ai/posts/automation-assistant-beta
- Chrome worker lifecycle: https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle
- Chrome optional permissions: https://developer.chrome.com/docs/extensions/reference/api/permissions
- Chrome content scripts: https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts
- Chrome scripting: https://developer.chrome.com/docs/extensions/reference/api/scripting
- Chrome side panel: https://developer.chrome.com/docs/extensions/reference/api/sidePanel

Future CREAO adapter only: reviewed documentation described server-side `cr_sk_` credentials, asynchronous `POST /v1/agents`, polling `GET /v1/runs/{run_id}`, and execution through `POST /v1/runs`. This was documentation verification, not an authenticated live test. Do not implement these in the current milestone.

---

## 16. Builder delivery checklist

When authorized to implement, deliver:

- Source, lockfile, reproducible build, and unpacked extension artifact/instructions.
- Backend setup and a secret-free environment-variable example.
- Schema/version documentation and sample sanitized JSON/Markdown definition.
- Exact permissions and captured-field documentation.
- Data flow, retention, hosted-sharing, and deletion-scope documentation.
- Automated test commands and actual results, including any failed/skipped tests.
- Manual Chrome verification checklist with observed results.
- Repeatable demo and reset instructions.
- Known limitations, unsupported surfaces, and remaining decisions.
- Clear disclosure of live AI versus mocked test behavior.

Do not call the MVP complete merely because tests pass or exports look plausible. Completion requires the actual browser capture → persistent evidence → approved hosted interpretation → correction → definition export flow to work, with privacy controls verified.
