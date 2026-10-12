# Verification status

## Performed

- Cloned the requested empty repository into `/Users/ankojh/b12/observe`.
- Installed dependencies and generated `package-lock.json`.
- `npm run typecheck`: passed for the shared core, extension, and backend.
- `npm run build`: passed; created a Manifest V3 artifact with panel HTML/CSS/JS, module worker, dynamic content bundle, and manifest.
- `npm run package`: creates `observe-extension.zip` from the production unpacked artifact.
- `npm audit --omit=dev`: reported **0 vulnerabilities** at build time. This is not a security/privacy audit.
- Started the actual backend module on loopback with a synthetic extension origin and **live AI explicitly disabled**. Unauthenticated health request returned **401**; bearer-authenticated health request with the configured Origin returned **200**, `configured:false`, `mockProvider:false`. The process was stopped afterward. No credential/token was printed and no provider call was made.
- Generated the sanitized JSON/Markdown documentation samples from the same core definition builder/schema. They are clearly labeled documentation examples, not recorded observations or live AI results.
- Inspected the built artifact file list and Git ignore rules. Pairing token/SQLite data, real `.env`, node_modules, dist, and ZIP are excluded from Git.

### Jev and content-aware update (2026-10-11)

- `npm run typecheck` and `npm run build`: passed.
- Offline shape check: each Jev request kind produces the documented `systemone` question shapes, and `decode` parses documented example answers (choice → action, nouls → relevance, choice → pattern ID or new task). This check caught and fixed a decision-schema bug. It used no network.
- Backend started on loopback with the real `.env` but no TypeSafe key: unauthenticated `POST /jev` → **401**; authenticated `/health` → `jev.configured:false`; authenticated `POST /jev` → **503** "Jev disabled". Stopped afterwards. No OpenAI or Jev call was made.
- **Live Jev via the backend `/jev` route** (`jev-latest` → `jev-1.13.0`), 10 synthetic requests, 80–230 ms each, 5,811 input tokens in total:
  - action: "Archive conversation" → `delete` 0.99; "Submit for approval" → `save` 0.78; "⋯" → `unknown` 0.84.
  - relevance: invoice excerpt → relevant 0.93 / sensitive 0.02; navigation and cookie boilerplate → relevant 0.06 (dropped); medical note → sensitive 0.98 (dropped).
  - boundary: after save and submit → 0.63 (**below the 0.7 suggestion threshold**); mid-task → 0.10.
  - match: invoice episode against [support, invoice] → the invoice pattern at 1.0; support episode against [invoice] → new task at 0.99.
- Synthetic API checks only; the extension hasn't yet made these calls from Chrome, and thresholds aren't tuned on real use.

### Always-on discovery update (2026-10-12)

- `npm run typecheck` and `npm run build`: passed.
- `npm run jev:eval` against live Jev: **49/49** synthetic cases passed (25,096 input tokens). Route templates 5/5, value sources 3/3, site screening 12/12, actions 8/8, triage 8/8, boundaries 4/4, relevance/outcome 5/5, matching 4/4.
- Weak margins: "ticket vs [invoice]" chose new task at 58%; "Submit for approval" → save at 69%; shopping scored routine 58% (discarded on work 15%). The `automatable` score was 85–92% for every case, including social scrolling, so it is displayed but not used for decisions.
- **Not done:** any of this in Chrome. The previous Chrome checklist is still entirely pending.

Initial typechecking exposed incorrect relative imports; those were fixed before the successful builds. Node 22's `node:sqlite` experimental warning is expected. No automated tests were added or executed, by explicit owner request.

## Not performed — do not call these passed

- Loading the unpacked artifact in actual Chrome, verifying the side panel, permissions, sender metadata, capture, accurate badge, and real UI usability.
- Privacy-canary inspection of IndexedDB, extension storage, actual network requests, and exports.
- Chrome worker/browser restart and quota/error recovery.
- Pause/revoke/reset races in Chrome, including an in-flight inference.
- Real live OpenAI account/model call, actual strict-output compatibility, provider cost/terms verification, and hosted end-to-end acceptance.
- Two successful clean-profile reset-to-record-to-live-analysis-to-correction-to-export runs.
- Any real Jev call, Jev decision quality, or threshold tuning.
- Content-aware recording in Chrome: badge, field skipping, redaction, 24-hour expiry.

The code/build is delivered; these manual acceptance checks remain necessary. Model, credentials, current prices, authorized USD caps, and approved account terms have not been supplied. The live feature is deliberately unavailable until configured rather than silently spending or using a fake provider.

## Manual Chrome checklist (pending)

Use the synthetic pages and instructions in `demo.md`.

- [ ] First install: observation disabled and zero events.
- [ ] Approve exactly one scheme/host, verify Chrome's prompt scope, and start.
- [ ] Ordinary controls capture enum categories without custom DOM attributes.
- [ ] Unapproved origins, background tabs, incognito, and unsupported surfaces do not capture.
- [ ] Input/textarea/contenteditable/password/email/payment values and canary page titles, routes, query strings, labels, IDs, and prose are absent from stored events.
- [ ] Full navigation and SPA transitions emit generic page categories without raw locations.
- [ ] Pause acknowledges a durable gate; later stale-epoch messages do not commit. Re-enable cannot replay them.
- [ ] Revoke while the tab remains open disables capture immediately; registrations/listeners cannot bypass the gate.
- [ ] Repeated startup/injection has no duplicate listeners or double-counted event IDs.
- [ ] Close/reopen side panel, restart worker, restart browser: committed evidence/corrections survive; no spurious occurrence multiplication.
- [ ] Three related completed episodes including a variant group; unrelated sequence does not. Overlapping activity is never counted twice.
- [ ] Cross-app transition is preserved and known hidden/unfocused timing is excluded; durations remain explicitly approximate.
- [ ] Inspect occurrence refs, correct intent/rule, record a held-out related episode, and confirm only that workflow inherits the correction.
- [ ] Exclusion invalidates counts/drafts/jobs; dismissal remains suppressed until restoration or three new occurrences.
- [ ] No upload occurs until exact summary approval. Editing/redacting requires fresh approval and cannot change factual counts/actions.
- [ ] Pairing authentication, strict Origin/Host, failure messages, model evidence validation, budget/timeouts, and idempotent job recovery work with a real configured backend.
- [ ] Hosted output cannot invent observed claims, quoted confirmations, evidence refs, confirmed rules, or verified capabilities.
- [ ] User/model prose renders as text, never HTML/code.
- [ ] Edit/validate/save/export incomplete definition with conspicuous questions. Both export formats agree and do not contain secrets, scripts, selectors, or raw browsing metadata.
- [ ] Delete while a job runs; no late response repopulates local data. Best-effort cancellation and provider retention limits are disclosed.
- [ ] Retention invalidates affected episode/workflow claims and drafts; quota errors block capture or visibly report when durable pause cannot be persisted.
- [ ] Repeat the full reset-to-export demonstration twice, explicitly identifying live AI versus manual drafting.
- [ ] Content-aware session: start requires site selection and acknowledgment; on-page badge and `TXT` badge appear; session ends on Stop, pause, one-hour expiry, and browser restart.
- [ ] Password, email-type, payment, login, OTP, and fields in password forms are never captured; canary secrets in visible text are redacted or dropped.
- [ ] Jev on: an unknown-label control (e.g. "Archive conversation") is stored with a Jev action; Settings shows `ready`, the model, and a decision count.
- [ ] Jev drops boilerplate and canary-sensitive content records; relevant ones are stored with a relevance value.
- [ ] Jev boundary suggestion appears after a save/send/submit and disappears after further activity; it never closes an episode itself.
- [ ] Jev groups three related content episodes that local rules would miss, and keeps an unrelated one separate; patterns show `Jev NN%`.
- [ ] Jev off in Settings, backend stopped, or no key: capture continues, the status explains why, and grouping falls back to `local`.
- [ ] Pause during an in-flight Jev call: the event is not stored.
- [ ] Captured content in the OpenAI sharing preview can be redacted; factual fields cannot.
- [ ] **Record on all websites** requests one grant; recording starts on any ordinary site without approving it; the badge reads `TXT`.
- [ ] Locally listed sites (e.g. a `.gov` or bank domain) are `SKIP` before any capture; a Jev-sensitive site is skipped and its stored data purged.
- [ ] Block/Unblock a discovered site; blocking purges its data.
- [ ] An episode closes automatically after a clearly finished task (Jev ≥ 0.8) or idle; **End episode** is optional.
- [ ] A finished routine task appears in Patterns as *Candidate · seen once*; a casual browsing episode is discarded and the discard count increases; its events and text are gone from IndexedDB.
- [ ] A repeat joins the candidate, which becomes *Pattern · repeated*.
- [ ] Unpinned single candidates expire after 7 days; pinned ones stay.
- [ ] Timeline shows element names and ID-free routes; no query strings or IDs appear in stored routes.
- [ ] Field edits copied from page text are marked `copied`; the snapshot after a save is linked as its outcome with a success probability.
- [ ] Turning off page-text capture stops content records immediately; text captured under the old setting is never committed.

## Known MVP constraints

- Conservative exact-label classification means many rich/icon-only/nested controls are unknown; generic intent is inherently ambiguous.
- Explicit task boundaries are important. Automatic segmentation is not business-process understanding, and 120-event bounds can split long tasks.
- Safe-control overlap is intentionally required for grouping; repeated unknown actions or a single repeated control may remain ungrouped.
- Timing is a capped foreground estimate and can substantially undercount long thinking/typing work.
- Route polling can miss brief transitions; JS-only submits, navigation/crashes and discarded contexts may lose events. Capture gaps are not universally detectable.
- No iframe/shadow/canvas/native monitoring, screenshots, scraping, replay, execution, adapters, or remote deployment support.
- Provider responses can fail validation; they are surfaced as failures, never replaced by fabricated interpretations.
- Prior interpretations are bounded to ten archived versions; evidence deletion invalidates their dependent claims. Human draft edits do not silently refresh when evidence changes; regenerate explicitly.
- OpenAI and cost guards require correct owner-supplied configuration; local estimates are not a guaranteed provider billing cap.
