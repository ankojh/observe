# Repeatable manual demo (no fabricated evidence)

Use a clean Chrome profile with only synthetic data. Do not start with a private inbox or production CRM.

## Start

```sh
npm ci
npm run build
node scripts/demo-sites.mjs
```

The demo serves ordinary HTML at `http://127.0.0.1:4401` and `http://localhost:4402`. They have no `data-observe-*` capture hooks or scripted recommendations. If localhost resolves only to IPv6 on your machine, navigate to the corresponding IPv4 origin instead and approve it explicitly. The two apps' functional scope is intentionally tiny; clicks show safe categories, **not evidence of business success**.

1. Load `apps/extension/dist` unpacked, open Observe, and reset local memory. Leave **Keep site approvals** unchecked.
2. Open each demo app separately and approve each **origin** in Observe. Site permission capability may cover all ports but consent still checks the exact approved origin. Start observation after approvals are finished.
3. On request queue: click **Open** to open the record workspace in another tab.
4. In record workspace: click **Search**, **Edit**, **Save** (the ordinary form may navigate), and **Back**. Switch back to the queue and click **Reply**.
5. Use **End episode** in Observe. Inspect its real safe sequence and any capture gaps. Save is an activation; submit is an attempt; no record update is claimed.
6. Repeat twice. Add **Close** as a harmless variant on one run. Avoid >2 minute idle or visiting an unapproved tab while a task is in progress. Check that distinct episodes group; thresholds are conservative, so inspect unexpected splits instead of substituting fake counts.
7. Perform an unrelated sequence, such as **Next**, **Close**, **Back** in the queue, and end the episode. Verify it does not join the earlier pattern. Ordinary buttons may have no application effect; the purpose is to demonstrate recorded UI evidence honestly.
8. Inspect timeline and occurrence variants. A candidate's count is only completed, distinct grouped episodes. Approximate active time is event-derived and may be very short for staged clicks.

## Always-on discovery path (current default)

1. Add `TYPESAFE_API_KEY` and `JEV_MAX_DAILY_TOKENS` to `apps/backend/.env`, start the backend, and pair. Settings should show *Jev ready*.
2. Click **Record on all websites**. Open both demo apps; each appears in Settings → Sites as *Recording*, without approving it. The badge reads `TXT`.
3. Do the request-queue task once, typing a short synthetic note. After **Save** or **Reply** the episode may close by itself; otherwise use **End episode**. It should appear in Patterns as *Candidate · seen once*, with Jev work/routine scores.
4. Repeat it; the candidate becomes *Pattern · repeated* (`Jev NN%`).
5. Click around aimlessly (Next, Close, Back) and end the episode: it should be discarded and the *discarded today* count should increase.
6. Turn Jev off in Settings, record one more episode, and confirm local rules keep it.

## Hosted interpretation path

1. Configure/pair the loopback backend as in README. A real approved model, credentials, prices, limits, and account terms are required. No fixture response is available.
2. In Patterns choose **Name & explain with OpenAI** (available from one occurrence). Inspect the complete JSON. Optional alias/correction redaction is allowed; code-computed factual fields cannot be edited. No hostnames, full routes, input values, or labels should appear unless manually supplied in an approved alias/correction.
3. Explicitly approve this exact payload. Show saved `pending`/`running` status, close/reopen the panel, and retrieve the actual job result.
4. If provider setup/network/schema validation fails, display the failure honestly. The local manual path remains available; do not present it as live AI.
5. Confirm the purpose: e.g. **This is request qualification, not a general record update.** Add a rule such as **Require a human to approve every proposed reply.** These are user-confirmed, not observed facts.
6. Record another related episode. Its workflow summary and later draft should inherit only this group's current confirmed intent/rules.
7. Use **Correct** on a rule if needed; it creates versioned superseding feedback. Use **This occurrence is unrelated** to exclude a wrong grouping; counts and drafts must update.
8. Select **Review AI draft request**. This is a **second** sharing approval, with full evidence, interpretation and corrections previewed again. Await actual structured output.

## Manual resilience path

If AI is unavailable, choose **Local manual draft** from a pattern. The resulting provenance is `manual`, with explicit unknowns and zero assumed savings. It is not an AI substitute. Explain which path you used in the demonstration.

## Edit, export, reset

1. In Agent drafts edit goal, typed inputs, semantic steps, rules, and unresolved questions. Inputs must describe requirements, not observed values. Use the full JSON editor for advanced fields/dependencies/approval boundaries. Confirmed rules are corrected in Patterns.
2. Leave incomplete business rules as unanswered questions; do not fabricate them. Reviewed status requires no unanswered questions, but still does not mean runnable/deployed.
3. Save validates the versioned schema and increments the definition version. Provenance remains code-assigned; all capabilities stay unverified.
4. Preview the entire JSON or Markdown. Explicitly confirm export. Both contain the same validated object; local evidence refs will not resolve elsewhere.
5. State: **This definition is not executable or deployed.** Exported files cannot be recalled by local reset.
6. Pause, then reset with approvals unchecked. Timeline, patterns, corrections, drafts, and local jobs must disappear. In-flight late results must not restore them. Backend cancellation is best-effort, and provider retention is not erased.
7. Repeat from clean state to verify consistency. **Two successful browser-to-live-AI-to-export runs have not yet been verified by the builder.**
