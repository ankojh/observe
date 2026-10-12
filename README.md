# Observe

A **Chrome Manifest V3 extension** for privacy-minimized workflow discovery. Record safe categories on explicitly approved sites, group distinct completed episodes locally, review a minimized summary before sharing with OpenAI, correct its interpretation, and export an editable **non-executable** agent definition.

This is a buildable MVP implementation, not a claim of verified browser or live-provider acceptance. Automated tests were intentionally deferred at the owner's request. There is no mock AI, agent execution, replay, CREAO integration, or cloud event-stream storage.

## Build and load in Chrome

Requires Node **22.21+**, npm, and desktop Chrome **120+**.

```sh
cd /Users/ankojh/b12/observe
npm ci
npm run build
```

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select `/Users/ankojh/b12/observe/apps/extension/dist`.
3. Click the Observe toolbar action to open its **side panel**. Pin it if desired.
4. Navigate to an ordinary HTTP(S) site. Click **Approve this scheme & host**, then **Start**.
5. Inspect the real timeline. Mark each task complete using **End episode**.
6. Repeat related sequences; three distinct completed occurrences enable **Review & analyze**.

No capture is enabled on first install. Optional HTTP(S) capability is not blanket access. Chrome grants a scheme/host across paths/ports; Observe additionally checks an exact approved origin (including port). No subdomain wildcard is requested.

`npm run package` creates `observe-extension.zip`; the unpacked build directory is the installation artifact. `npm run dev:extension` is only a panel UI development server, **not** the installable extension. Rebuild and reload the extension after changing worker/content code. Refresh observed tabs after reloading the extension.

## Loopback OpenAI backend

The provider decision is **OpenAI**; the backend decision is **loopback-only**. The model, credentials, approved account terms, and spending limits remain explicitly configurable. Nothing reads credentials from other projects, and no provider request is made during build or setup checks.

1. Load the extension and copy **Extension origin** from Observe's Settings.
2. Copy the secret-free configuration:

   ```sh
   cp apps/backend/.env.example apps/backend/.env
   ```

3. Set `OBSERVE_EXTENSION_ORIGIN` to the exact `chrome-extension://…` value. Start the server:

   ```sh
   npm run backend
   ```

   With only the extension origin configured, the server starts with **live AI disabled**. It binds only `127.0.0.1:4317`.
4. Open `apps/backend/data/pairing-token.txt` locally and copy the generated random token into extension **Settings → Backend pairing → Pair & check**. This asks for separate loopback host access. Never commit/share the token or `.env`.
5. To enable actual AI, supply `OPENAI_API_KEY`, an owner-approved `OPENAI_MODEL` supporting Chat Completions with strict structured JSON output, positive per-request/daily USD caps, current input/output token prices, and `PROVIDER_TERMS_ACKNOWLEDGED=true`. Restart the backend.
6. In **Patterns**, review the **entire exact outbound JSON**. You can redact app aliases and correction wording; observed actions, references, counts, and limitations remain code-authoritative. Approve that specific payload to submit a request.
7. Confirm/correct intent and rules. Create a manual local draft, or approve a **separate** AI definition request. Review, edit, validate, and export JSON/Markdown.

Cost guards reserve a conservative estimate using UTF-8 input bytes plus schema/protocol headroom and the output token cap. They are local guards, **not an invoice guarantee**; correct model prices and provider-side account limits are still required. There are no automatic charged provider retries.

Jobs persist in SQLite; extension jobs persist in IndexedDB. Close/reopen the panel to resume status retrieval. Interrupted backend jobs become visible failures after restart. Results expire after 24 hours; no reviewed request payload is written to the backend database. See [architecture](docs/architecture.md) and [privacy](docs/privacy.md).

## Manual path / AI unavailable

Capture, local matching, evidence inspection, feedback, manual drafting, editing, and export need no backend. **Local manual draft** is clearly labeled `manual`. It leaves unanswered questions explicit and does not substitute canned AI output. Hosted interpretation and hosted drafting remain disabled/unavailable until actual backend/provider setup is complete.

## Source map

- `apps/extension/src/background.ts`: serialized ingestion, consent gates, lifecycle, episode persistence, feedback, local jobs.
- `apps/extension/src/observation/content.ts`: generic isolated-world safe capture on dynamic host registrations.
- `apps/extension/src/storage/db.ts`: versioned extension-origin Dexie/IndexedDB.
- `apps/extension/src/ui/`: React side panel, sharing approvals, editor, export previews.
- `packages/core/src/`: strict shared schemas, pure sequence similarity, summaries, definitions, Markdown.
- `apps/backend/src/`: paired loopback API, persisted jobs, bounded live OpenAI adapter.
- `scripts/demo-sites.mjs`: ordinary synthetic demo pages; no special capture attributes.

## Documentation and verification

- [Architecture and schema contracts](docs/architecture.md)
- [Permissions, privacy, retention, and deletion](docs/privacy.md)
- [Repeatable manual demo](docs/demo.md)
- [Verification performed and remaining acceptance](docs/verification.md)
- [Original builder handoff](docs/builder-handoff.md)
- [Sanitized sample definition](docs/sample-definition.json) / [Markdown](docs/sample-definition.md)

`npm run typecheck` checks all TypeScript. `npm run build` typechecks and creates the unpacked extension. No automated test suite has been added or run. Manual Chrome checks and live OpenAI end-to-end validation are still required; see the verification document for exact status. No commits or pushes were made.
