# Permissions and privacy contract

## Permissions

Required:

| Permission | Purpose |
|---|---|
| `sidePanel` | Primary user interface, opened by toolbar action |
| `storage` | Pairing token in trusted extension-only storage |
| `scripting` | Register/inject/remove content scripts on approved hosts |
| `activeTab` | Discover current site after a toolbar user gesture, without blanket browsing permission |

Optional `http://*/*` and `https://*/*` only declare the ability to request later **narrow scheme/host permissions**. No `<all_urls>` required grant, tabs/history/debugger/cookies/clipboard/screen capture/webRequest/webNavigation permission exists. Tab/window foreground events are available without the broad `tabs` permission; unapproved URL metadata is not collected. Unsupported Chrome pages do not capture.

Chrome match patterns cover all paths and ports on one host and scheme, but do not grant subdomains. The local consent list additionally requires exact origins including port. The permission request and this distinction are displayed. Revocation removes local approval immediately, advances epoch, disables already-open scripts, and removes Chrome permission where not shared with another approved origin on the same host or loopback pairing. Backend access is a separate user action for `http://127.0.0.1/*`; it never puts the backend origin into observed sites. If a loopback host grant is retained for pairing, no revoked origin captures because consent is an independent gate.

## Fields persisted

- Random event ID and per-document random reference/sequence.
- Worker receipt timestamp, local random site ID, numeric tab ID, consent epoch.
- Category: page enter, route change, control activation, form submit **attempt**, visibility change.
- Action enum: open/search/save/edit/next/back/reply/send/cancel/delete/add/close/unknown.
- Coarse role: page/button/link/form/unknown and visible hint.

Actual approved origin and scheme/host match pattern exist **only in local consent settings**, for managing permissions. No route category is guessed; generic routes remain generic. Event records never contain page titles, full URLs, query strings, fragments, referrers, arbitrary path segments, selectors, element IDs, raw labels/ARIA labels, clipboard, key streams, screenshots, cookies, or network payloads. Page text and field values are stored **only** as separate content records during an explicit content-aware session (below).

Classifier reads only a candidate control's short ARIA label or bounded direct text nodes to compare against an **exact fixed allowlist**, then discards the source. When that yields `unknown`, the control's accessible name (ARIA label, title, or text; at most 120 characters) travels to the worker as a transient `hint`, is redacted, may be sent to Jev for classification (below), and is then discarded. Only the resulting action enum is stored. Editable controls/descendants and controls containing editables never have their values/labels read; inputs (including password/email/payment/search), textareas, selects, contenteditable and textbox roles are not activation targets. Rich nested labels degrade to unknown. No ancestor/adjacent prose is inspected. Synthetic programmatic clicks are ignored. Form capture does not examine fields/actions/URLs.

## Content-aware recording

Off by default. The user selects approved sites, acknowledges what is captured, and starts a one-hour session; browser restart, pause, permission removal, or **Stop** ends it. While active, an on-page badge (closed shadow root) is shown and the toolbar badge reads `TXT`.

- **Displayed text:** visible, fully in-viewport text from `main`/`article` (or `body`), at most 3,000 characters per snapshot and 3,000 DOM nodes walked, re-captured at most every three seconds after interaction/scroll/mutation. Hidden, `aria-hidden`, script/style, form-control, and iframe content is skipped.
- **Field edits:** settled before/after values (2 s after typing stops, on blur, or on submit) for visible, enabled text/search/number inputs, textareas, and contenteditable regions, at most 1,200 characters. Fields whose type, autocomplete, name, id, label, or placeholder suggests passwords, secrets, tokens, payment, banking, SSN, OTP/PIN, or login are skipped, as is any field in a form containing a password, `cc-*`, or one-time-code input.
- **Redaction:** deterministic patterns for bearer/API tokens, `key=value` secrets, email addresses, URLs, SSN-like and IBAN-like identifiers, and 13–19 digit numbers, applied in the page and again in the worker. This is best effort, **not** secret detection or anonymisation.
- **Retention:** content records expire after 24 hours (1,000-record cap); dependent episodes, patterns, interpretations, and drafts are invalidated.

## Jev live decisions (TypeSafe)

When the backend is paired and configured with `TYPESAFE_API_KEY`, the worker sends minimized data through the loopback backend to TypeSafe's Jev (`api.typesafe.ai/v1/systemone`) **automatically while recording**, without per-request approval. This is an owner decision; it can be turned off in Settings → *Send recordings to Jev*. Jev returns only probabilities; the backend owns the fixed question templates.

| Decision | Sent to Jev | Effect |
|---|---|---|
| Action classification | Redacted control label (≤120 chars), role, last 10 action descriptions | Unknown click → action enum if probability ≥ 0.5 |
| Content relevance | One redacted content record, last 10 action descriptions | Not stored if relevance < 0.3 or sensitive ≥ 0.5 |
| Task boundary | Episode brief | Suggestion only; the user confirms with **End episode** |
| Same-task matching | Episode brief + up to 8 locally shortlisted pattern briefs and confirmed purposes | Joins a pattern or starts a new one if probability ≥ 0.5; otherwise local rules decide |

An *episode brief* contains app aliases, up to 40 `alias: category → action` lines, up to three display excerpts (≤400 chars) and three field values (≤200 chars) from stored, already-redacted content records, and approximate active minutes. No URLs, origins, selectors, event IDs, or timestamps are sent. Calls happen only after the same consent gate as storage (approved origin, current epoch, focused tab, active content session for content); the commit is re-checked afterwards, so a pause during an in-flight call prevents storage but cannot un-send that call.

The backend persists only daily Jev input-token totals (for `JEV_MAX_DAILY_TOKENS`); request state and responses are not logged or stored. TypeSafe's retention is governed by its terms, not by local reset. If Jev is unavailable, disabled, slow (4 s timeout), or over budget, local rules decide and nothing is retried later.

## OpenAI sharing boundary

Nothing goes to OpenAI on capture, matching, pattern detection, or manual draft creation. To use OpenAI the user reviews the **whole exact JSON**, including stored confirmed corrections, and approves that payload. App refs are opaque; aliases default to `App 1`, `App 2`, etc. User-entered aliases/corrections can reveal sensitive information; preview is risk reduction, not guaranteed anonymity. Alias, correction, and captured content wording can be redacted in preview. Edited facts are rejected. Editing/new evidence/new corrections require fresh approval.

For OpenAI the backend accepts summaries/definition inputs, not arbitrary event streams or snapshots. It uses no tools. Only it holds provider credentials. Pairing tokens/provider secrets never enter summaries or exports. Requests and upstream response bodies are not logged. Provider errors are sanitized. Model/user text is displayed as React text; no unsanitized HTML or generated-code execution.

## Retention, reset, and cancellation

- Content records: 24 hours / 1,000 records. Content sessions: one hour.
- Local evidence default: seven days / 10,000 events. Cleanup on use/wake, not a timer while Chrome is closed. Expired evidence invalidates affected episodes, related summaries, jobs, and drafts; no unsupported counts remain.
- Pause gates writes before acknowledgment. Old epochs stay invalid after resuming.
- Revoke disables a site; historical local evidence stays inspectable until deleted or expired.
- Delete an episode removes its events and invalidates dependent drafts/interpretations/jobs.
- Reset first pauses capture and advances epoch/data generation, then clears raw and derived local memory. Keeping site approvals is an explicit unchecked option; it never resumes capture. Pairing configuration is separate and can be forgotten in Settings.
- Job cancellation requests to the backend are **best effort**; local invalidation is authoritative even if the backend is unavailable. Backend cancels fetch and erases retained result when reachable. A queued approved payload may remain in transient process memory until the queue advances; a network call already made cannot be un-sent.
- Backend results expire after 24 hours (hourly cleanup). SQLite keeps no raw observations or approved payload text, only request digest/metadata and validated results. Aborting does not guarantee no provider charge or retention.
- OpenAI data handling is governed by the selected account's applicable terms; `store:false` is sent but is not a zero-retention guarantee. Account terms must be acknowledged before live configuration enables requests.
- Data already sent to Jev cannot be recalled by pause, deletion, or reset.
- JSON/Markdown files leave extension storage. Local reset **cannot recall exported files** or delete prior provider retention.

## Limitations / honesty

No iframe, closed-shadow-root, canvas, privileged-page, incognito or native desktop support. Unknown controls remain unknown. Polling can miss transient routes. Some JS-only submit flows and navigation/crash events can be lost; retries are bounded and gaps only partially detectable. UI labels describe attempted actions, never business success. Foreground timing is approximate and conservative. Schema/ref validation cannot prove inferred intent; confirmation and deployment-capability validation remain required.

A privacy audit in actual Chrome has not yet been performed. Use only synthetic data until the documented manual checks have been completed. Tests were deferred, not silently claimed to pass.
