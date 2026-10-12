# Permissions and privacy contract

Observe records in the background once allowed, screens out sensitive sites, sends minimized data to TypeSafe's Jev for live decisions, and keeps only episodes Jev judges to be routine work. This is an owner-approved change from the original builder handoff, which kept capture opt-in per session and excluded page text and field values. The safeguards below are best-effort risk reduction, **not** a guarantee that no sensitive data is captured or shared.

## Permissions

Required:

| Permission | Purpose |
|---|---|
| `sidePanel` | Primary user interface, opened by toolbar action |
| `storage` | Pairing token, Jev setting, and discard counter in trusted extension-only storage |
| `scripting` | Register/inject/remove the content script |
| `activeTab` | Discover the current site after a toolbar user gesture |

Optional `http://*/*` and `https://*/*` are requested together only when the user chooses **Record on all websites** (Chrome shows "Read and change all your data on all websites"). Alternatively the user approves single sites, which requests a narrow scheme/host permission as before. No tabs/history/debugger/cookies/clipboard/screen-capture/webRequest/webNavigation permission exists. Incognito, privileged Chrome pages, and the loopback backend origin are never captured.

Revoking all-sites access in Chrome or in Settings disables discovered sites at the next reconcile; manually approved sites keep their own grants. Backend access is a separate grant for `http://127.0.0.1/*`.

## Sensitive-site screening (all-sites mode)

Each newly visited origin becomes a local site record, aliased by hostname.

1. **Local list, before anything is read:** `.gov`/`.mil`/`.bank` suffixes, `login.`/`signin.`/`sso.`/`auth.`/`accounts.`/`id.`/`secure.` subdomains, and a list of banks, brokers, payment apps, patient portals, password managers, identity providers, payroll providers, and adult sites. Matching sites are marked skipped and never captured.
2. **Jev, on first visit:** the hostname and redacted page title (≤120 chars) are classified. Banking/finance, healthcare, government, password/identity, HR/payroll, and adult categories with combined probability ≥ 0.5 mark the site skipped and **purge** anything already stored for it. Until Jev answers, the site records locally (nothing leaves the machine without Jev), and the check retries on later visits.
3. **User block:** any discovered site can be blocked from the panel or Settings; blocking purges its stored data.

The page title is used only for this check and is not stored. Webmail is not treated as sensitive, because it is a core workflow source; individual records are still filtered (below).

## What is captured on recorded sites

Events (always):

- Random event ID, per-document random reference/sequence, worker receipt time, local site ID, tab ID, consent epoch.
- Category (page enter, route change, control activation, form submit **attempt**, visibility change), action enum, coarse role.
- **Target:** the activated control's accessible name (ARIA label, title, or text), redacted, ≤80 chars. Not read from editable controls or controls containing them.
- **Route:** the page path (and hash route) with numeric, UUID-like, email-like, and long-token segments replaced by `:id`, on page enter and route change. No host, query string, or fragment parameters. Slug-like segments (for example a name in a path) are not removed; this is a known gap.

Page text and field edits (on by default; Settings → *Capture page text and field edits*):

- **Displayed text:** visible, fully in-viewport text from `main`/`article` (or `body`), ≤3,000 chars per snapshot and ≤3,000 DOM nodes walked, at most every three seconds after interaction, scroll, or mutation. Hidden, `aria-hidden`, script/style, form-control, and iframe content is skipped.
- **Field edits:** settled before/after values (2 s after typing stops, on blur, or on submit) for visible, enabled text/search/number inputs, textareas, and contenteditable regions, ≤1,200 chars. Fields whose type, autocomplete, name, id, label, or placeholder suggests passwords, secrets, tokens, payment, banking, SSN, OTP/PIN, or login are skipped, as is any field in a form containing a password, `cc-*`, or one-time-code input.
- **Value source:** for each field edit, whether the value was copied from, derived from, or independent of recently displayed text, with a reference to that display record. Computed locally.
- **Outcome:** the first page snapshot within 15 s after a submit/save/send/reply/delete/add in the same tab is linked to that action and judged by Jev for success.
- **Redaction:** deterministic patterns for bearer/API tokens, `key=value` secrets, emails, URLs, SSN-like and IBAN-like identifiers, and 13–19 digit numbers, in the page and again in the worker. Best effort, not secret detection.

There is no on-page badge in always-on mode; the toolbar badge shows `TXT` (recording with page text), `ON` (events only), `SKIP` (sensitive or blocked site), `—` (nothing to record here), or `OFF` (paused).

## Jev live decisions (TypeSafe)

When the backend is paired and configured with `TYPESAFE_API_KEY`, the worker sends minimized data through the loopback backend to Jev (`api.typesafe.ai/v1/systemone`) **automatically while recording**, without per-request approval. Settings → *Send recordings to Jev* turns this off. Jev returns only probabilities; the backend owns the fixed question templates.

| Decision | Sent to Jev | Effect |
|---|---|---|
| Site screening | Hostname, redacted page title | Skip and purge at ≥ 0.5 sensitive |
| Action classification | Redacted control name, role, last 10 activity lines | Unknown click → action enum at ≥ 0.5 |
| Content relevance, page type, outcome | One redacted content record, last 10 activity lines | Not stored if relevance < 0.3 (except outcomes) or sensitive ≥ 0.5 |
| Task boundary | Episode brief | Auto-close at ≥ 0.8; suggestion at ≥ 0.6 |
| Triage | Episode brief | Saved as a candidate only if work ≥ 0.5 and routine ≥ 0.5; otherwise **deleted** |
| Same-task matching | Episode brief + up to 8 locally shortlisted pattern briefs and confirmed purposes | Saved as a repeat of that pattern at ≥ 0.5 |

An *episode brief* contains app aliases (hostnames in all-sites mode), up to 40 activity lines (`alias: category → action [target] @ route`), up to three display excerpts (≤400 chars) and three field values (≤200 chars) from stored, already-redacted records, and approximate active minutes. No full URLs, selectors, event IDs, or timestamps.

Calls happen only after the same consent gate as storage (recordable site, current epoch, focused tab, content capture on for content); the commit is re-checked afterwards, so a pause during an in-flight call prevents storage but cannot un-send that call. The backend persists only daily Jev input-token totals for `JEV_MAX_DAILY_TOKENS`; request state and responses are not logged or stored. TypeSafe's retention is governed by its terms, not by local reset. If Jev is unavailable, disabled, slow (4 s timeout), or over budget, local rules decide and nothing is retried later; without Jev, every episode with at least two recognised actions or enough captured text is kept.

## Keep or discard

When an episode ends, it is matched against existing patterns, then triaged. Discarded episodes have their events, page text, and episode record deleted immediately; only a per-day discard count remains. Saved episodes keep their events and a trimmed set of text: field edits (≤30), outcome snapshots, and the latest display per page type (≤5). Navigation-only episodes are always discarded.

## OpenAI sharing boundary

Nothing goes to OpenAI on capture, triage, matching, or manual draft creation. To name or explain a pattern, the user reviews the **whole exact JSON** (now including clicked element names and routes) and approves that payload. Aliases, corrections, and captured content wording can be redacted in the preview; edited facts are rejected; changes require fresh approval. The backend accepts summaries and definition inputs only, holds the credentials, uses no tools, and does not log requests or upstream bodies.

## Retention, reset, and cancellation

- Unsaved page text: 24 hours / 3,000-record cap, deleted without invalidating episodes. Saved evidence follows event retention.
- Candidates seen once expire after 7 days unless pinned or repeated.
- Events: seven days by default (1–30) / 10,000 events. Cleanup on use/wake. Expired evidence invalidates affected episodes, summaries, jobs, and drafts.
- Pause gates writes before acknowledgment; old epochs stay invalid after resuming.
- Blocking a site or a sensitive verdict purges that site's stored data. Revoking a manually approved site disables it; its history stays until deleted or expired.
- Reset pauses capture, advances epoch and data generation, clears local memory, and (unless sites are kept) removes the all-sites grant.
- Backend job cancellation is best effort. Backend results expire after 24 hours. OpenAI and TypeSafe retention follow their account terms; data already sent cannot be recalled by pause, deletion, or reset.
- Exported JSON/Markdown files cannot be recalled by local reset.

## Limitations / honesty

Sensitive-site screening is a heuristic list plus a classifier; misclassification is possible, and webmail, chat, CRM, and docs often contain other people's personal data. Consider workplace policy and data-protection obligations before recording at work. No iframe, closed-shadow-root, canvas, privileged-page, incognito, or native desktop support. Polling can miss transient routes; some submits and crash/navigation events are lost. Timing is approximate. Jev thresholds were set on a small synthetic evaluation set (`npm run jev:eval`) and need tuning on real use.

A privacy audit in actual Chrome has not yet been performed. Use only synthetic data until the manual checks in `verification.md` have been completed.
