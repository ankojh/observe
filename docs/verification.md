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

Initial typechecking exposed incorrect relative imports; those were fixed before the successful builds. Node 22's `node:sqlite` experimental warning is expected. No automated tests were added or executed, by explicit owner request. No commits or pushes were made.

## Not performed — do not call these passed

- Loading the unpacked artifact in actual Chrome, verifying the side panel, permissions, sender metadata, capture, accurate badge, and real UI usability.
- Privacy-canary inspection of IndexedDB, extension storage, actual network requests, and exports.
- Chrome worker/browser restart and quota/error recovery.
- Pause/revoke/reset races in Chrome, including an in-flight inference.
- Real live OpenAI account/model call, actual strict-output compatibility, provider cost/terms verification, and hosted end-to-end acceptance.
- Two successful clean-profile reset-to-record-to-live-analysis-to-correction-to-export runs.

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
