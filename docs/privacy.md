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

Actual approved origin and scheme/host match pattern exist **only in local consent settings**, for managing permissions. No route category is guessed; generic routes remain generic. There are no page titles, full URLs, query strings, fragments, referrers, arbitrary path segments, selectors, element IDs, raw labels/ARIA labels, input values, clipboard, key streams, screenshots, cookies, network payloads, or page-text dumps in event records.

Classifier reads only a candidate control's short ARIA label or bounded direct text nodes to compare against an **exact fixed allowlist**, then discards the source. Editable controls/descendants and controls containing editables never have their values/labels read; inputs (including password/email/payment/search), textareas, selects, contenteditable and textbox roles are not activation targets. Rich nested labels degrade to unknown. No ancestor/adjacent prose is inspected. Synthetic programmatic clicks are ignored. Form capture does not examine fields/actions/URLs.

## Sharing boundary

Nothing uploads on capture, matching, pattern detection, or manual draft creation. To use AI the user reviews the **whole exact JSON**, including stored confirmed corrections, and approves that payload. App refs are opaque; aliases default to `App 1`, `App 2`, etc. User-entered aliases/corrections can reveal sensitive information; preview is risk reduction, not guaranteed anonymity. Alias/correction text can be redacted in preview. Edited facts are rejected. Editing/new evidence/new corrections require fresh approval.

The backend accepts summaries/definition inputs, not arbitrary event streams or snapshots. It uses no tools. Only it holds provider credentials. Pairing tokens/provider secrets never enter summaries or exports. Requests and upstream response bodies are not logged. Provider errors are sanitized. Model/user text is displayed as React text; no unsanitized HTML or generated-code execution.

## Retention, reset, and cancellation

- Local evidence default: seven days / 10,000 events. Cleanup on use/wake, not a timer while Chrome is closed. Expired evidence invalidates affected episodes, related summaries, jobs, and drafts; no unsupported counts remain.
- Pause gates writes before acknowledgment. Old epochs stay invalid after resuming.
- Revoke disables a site; historical local evidence stays inspectable until deleted or expired.
- Delete an episode removes its events and invalidates dependent drafts/interpretations/jobs.
- Reset first pauses capture and advances epoch/data generation, then clears raw and derived local memory. Keeping site approvals is an explicit unchecked option; it never resumes capture. Pairing configuration is separate and can be forgotten in Settings.
- Job cancellation requests to the backend are **best effort**; local invalidation is authoritative even if the backend is unavailable. Backend cancels fetch and erases retained result when reachable. A queued approved payload may remain in transient process memory until the queue advances; a network call already made cannot be un-sent.
- Backend results expire after 24 hours (hourly cleanup). SQLite keeps no raw observations or approved payload text, only request digest/metadata and validated results. Aborting does not guarantee no provider charge or retention.
- OpenAI data handling is governed by the selected account's applicable terms; `store:false` is sent but is not a zero-retention guarantee. Account terms must be acknowledged before live configuration enables requests.
- JSON/Markdown files leave extension storage. Local reset **cannot recall exported files** or delete prior provider retention.

## Limitations / honesty

No iframe, closed-shadow-root, canvas, privileged-page, incognito or native desktop support. Unknown controls remain unknown. Polling can miss transient routes. Some JS-only submit flows and navigation/crash events can be lost; retries are bounded and gaps only partially detectable. UI labels describe attempted actions, never business success. Foreground timing is approximate and conservative. Schema/ref validation cannot prove inferred intent; confirmation and deployment-capability validation remain required.

A privacy audit in actual Chrome has not yet been performed. Use only synthetic data until the documented manual checks have been completed. Tests were deferred, not silently claimed to pass.
