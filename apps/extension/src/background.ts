import { z } from 'zod';
import { AgentDefinition, ContentData, ContentPayload, DefinitionDraft, DefinitionInput, EventPayload, Interpretation, WorkflowSummary, validateDraftGrounding, validateGrounding, type Episode, type ObservedEvent, type ContentRecord } from '../../../packages/core/src/schemas';
import { buildSummary, groupEpisode, LIMITS, token } from '../../../packages/core/src/learning';
import { makeDefinition } from '../../../packages/core/src/definitions';
import { CONTENT_LIMITS, contentTerms, redactContent } from '../../../packages/core/src/privacy';
import { db, state, hash, initialConsent, type Site, type AIJob } from './storage/db';

const BACKEND = 'http://127.0.0.1:4317';
let lane = Promise.resolve();
let captureBlocked = true; // Fail closed until persistent settings have been initialized.
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const task = lane.then(fn); lane = task.then(() => undefined, () => undefined); return task;
}
const safeError = (e: unknown) => e instanceof Error ? e.message.slice(0, 300) : 'Operation failed';
const trusted = (s: chrome.runtime.MessageSender) => s.id === chrome.runtime.id && s.url === chrome.runtime.getURL('index.html');
async function siteFor(sender: chrome.runtime.MessageSender): Promise<Site | undefined> {
  if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || sender.tab?.id === undefined || sender.tab.incognito || !sender.url) return;
  let origin: string;
  try { const url = new URL(sender.url); if (!['http:', 'https:'].includes(url.protocol)) return; origin = url.origin; } catch { return; }
  const consent = await state(); const site = consent.sites.find(s => s.origin === origin);
  if (!site || !await chrome.permissions.contains({ origins: [site.pattern] })) return;
  return site;
}
async function foreground(tabId: number): Promise<boolean> {
  try { const tab = await chrome.tabs.get(tabId); const win = await chrome.windows.get(tab.windowId); return tab.active === true && win.focused === true; } catch { return false; }
}
async function markTimingBreak() {
  const open = (await db.episodes.toArray()).find(e => !e.closed);
  if (open) await db.episodes.update(open.id, { timingBreak: true });
}
async function closeEpisode(reason: string, gap = false) {
  await db.transaction('rw', [db.episodes, db.workflows], async () => {
    const open = (await db.episodes.toArray()).find(e => !e.closed);
    if (!open) return;
    const completed = { ...open, closed: true, reason, gaps: gap ? [...open.gaps, reason] : open.gaps };
    await db.episodes.put(completed);
    const grouped = groupEpisode(completed, await db.workflows.toArray(), await db.episodes.toArray());
    if (grouped) await db.workflows.put(grouped);
  });
}
function contentConfig(consent: Awaited<ReturnType<typeof state>>, site?: Site) {
  const session = consent.contentSession;
  return !captureBlocked && consent.enabled && site && session && session.expiresAt > Date.now() && session.siteIds.includes(site.id) ? { id: session.id, expiresAt: session.expiresAt } : null;
}
async function reconcile() {
  const consent = await state();
  const registered = await chrome.scripting.getRegisteredContentScripts();
  const desired: Site[] = [];
  for (const site of consent.sites) if (await chrome.permissions.contains({ origins: [site.pattern] })) desired.push(site);
  if (desired.length !== consent.sites.length) {
    await db.consents.put({ ...consent, sites: desired, epoch: consent.epoch + 1 });
    await closeEpisode('Permission removed', true);
  }
  const stale = registered.filter(r => r.id.startsWith('observe-') && !desired.some(s => r.id === `observe-${s.id}`));
  if (stale.length) await chrome.scripting.unregisterContentScripts({ ids: stale.map(s => s.id) });
  const fresh = desired.filter(s => !registered.some(r => r.id === `observe-${s.id}`));
  if (fresh.length) await chrome.scripting.registerContentScripts(fresh.map(s => ({ id: `observe-${s.id}`, matches: [s.pattern], js: ['content.js'], runAt: 'document_idle', allFrames: false, persistAcrossSessions: true })));
  const tabs = await chrome.tabs.query({}); const current = await state();
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    const site = current.sites.find(s => { try { return tab.url && new URL(tab.url).origin === s.origin; } catch { return false; } });
    if (site) {
      try { await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, files: ['content.js'] }); } catch { /* Unsupported page: no capture. */ }
    }
    try { await chrome.tabs.sendMessage(tab.id, { type: 'capture.config', enabled: !captureBlocked && current.enabled && !!site, epoch: current.epoch, content: contentConfig(current, site) }, { frameId: 0 }); } catch { /* No content script. */ }
  }
  await updateBadge();
}
async function updateBadge() {
  const consent = await state(); const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const site = consent.sites.find(s => { try { return tab?.url && new URL(tab.url).origin === s.origin; } catch { return false; } });
  const collecting = !captureBlocked && consent.enabled && !!site && tab?.id !== undefined && await foreground(tab.id) && await chrome.permissions.contains({ origins: [site.pattern] });
  await chrome.action.setBadgeText({ text: consent.error ? '!' : collecting ? contentConfig(consent, site) ? 'TXT' : 'ON' : consent.enabled ? '—' : 'OFF' });
  await chrome.action.setBadgeBackgroundColor({ color: consent.error ? '#b74141' : collecting ? '#24856a' : '#67727f' });
}
async function prune() {
  let consent = await state();
  if (consent.contentSession && consent.contentSession.expiresAt <= Date.now()) {
    consent = { ...consent, contentSession: null, epoch: consent.epoch + 1 };
    await db.consents.put(consent); await closeEpisode('Content session expired'); await reconcile();
  }
  const events = await db.events.orderBy('time').toArray();
  const cutoff = Date.now() - consent.retentionDays * 86400000;
  const contexts = await db.contexts.orderBy('time').toArray();
  const expiredContent = contexts.filter((c, i) => c.time < Date.now() - CONTENT_LIMITS.retentionMs || i < contexts.length - CONTENT_LIMITS.recordCap).map(c => c.id);
  const old = new Set([...events.filter((e, i) => e.time < cutoff || i < events.length - LIMITS.eventCap).map(e => e.id), ...expiredContent]);
  if (!old.size) return;
  await db.transaction('rw', [db.events, db.episodes, db.workflows, db.feedback, db.definitions, db.aiJobs, db.contexts], async () => {
    const episodes = await db.episodes.toArray();
    const invalid = new Set(episodes.filter(e => e.eventIds.some(id => old.has(id))).map(e => e.id));
    // Whole affected episodes and dependent records are invalidated, never preserve unsupported counts.
    const removed = episodes.filter(e => invalid.has(e.id));
    const deleted = [...new Set([...old, ...removed.flatMap(e => e.eventIds)])];
    await db.events.bulkDelete(deleted); await db.contexts.bulkDelete(deleted);
    await db.episodes.bulkDelete([...invalid]);
    for (const workflow of await db.workflows.toArray()) {
      if (!workflow.occurrenceIds.some(id => invalid.has(id))) continue;
      const ids = workflow.occurrenceIds.filter(id => !invalid.has(id));
      await db.definitions.where('provenance.workflowId').equals(workflow.id).delete();
      await db.aiJobs.where('workflowId').equals(workflow.id).delete();
      if (!ids.length) { await db.workflows.delete(workflow.id); await db.feedback.where('workflowId').equals(workflow.id).delete(); }
      else await db.workflows.put({ ...workflow, occurrenceIds: ids, representativeId: ids.includes(workflow.representativeId) ? workflow.representativeId : ids[0], interpretation: undefined, interpretationHistory: [] });
    }
  });
}
async function ingest(sender: chrome.runtime.MessageSender, raw: unknown, enriched = false) {
  const parsed = enriched ? ContentPayload.parse(raw) : EventPayload.parse(raw);
  const consent = await state();
  const payload = 'data' in parsed ? { id: parsed.id, document: parsed.document, sequence: parsed.sequence, epoch: parsed.epoch, visible: parsed.visible, category: parsed.data.kind, action: 'unknown' as const, role: parsed.data.kind === 'content.display' ? 'page' as const : 'unknown' as const } : parsed;
  const site = await siteFor(sender);
  if (captureBlocked || !site || !consent.enabled || payload.epoch !== consent.epoch) return { ok: false, disabled: true };
  if (!await foreground(sender.tab!.id!)) return { ok: false, disabled: true };
  if (!payload.visible && payload.category !== 'page.visibility_change') return { ok: false, disabled: true };
  let data: ContentData | undefined;
  if ('data' in parsed) {
    const session = consent.contentSession;
    if (!session || session.id !== parsed.sessionId || session.expiresAt <= Date.now() || !session.siteIds.includes(site.id)) return { ok: false, disabled: true };
    const text = redactContent(parsed.data.text, CONTENT_LIMITS.excerptChars), after = redactContent(parsed.data.after, CONTENT_LIMITS.fieldChars);
    const before = parsed.data.before === null ? null : redactContent(parsed.data.before, CONTENT_LIMITS.fieldChars);
    const label = redactContent(parsed.data.label, CONTENT_LIMITS.labelChars);
    data = ContentData.parse({ ...parsed.data, text: text.text, after: after.text, before: before?.text ?? null, label: label.text, redactions: parsed.data.redactions + text.redactions + after.redactions + (before?.redactions ?? 0) + label.redactions, truncated: parsed.data.truncated || text.truncated || after.truncated || (before?.truncated ?? false) });
    if (data.kind === 'content.display' && !data.text.trim() || data.kind === 'field.edit' && data.before === data.after) return { ok: true };
  }
  const time = Date.now(); // Never accept a page-provided timestamp.
  const event: ObservedEvent = { ...payload, time, siteId: site.id, tabId: sender.tab!.id!, ...(data ? { contextRef: payload.id } : {}) };
  if (await db.events.get(event.id) || await db.events.where('[document+sequence]').equals([event.document, event.sequence]).count()) return { ok: true };
  let open = (await db.episodes.toArray()).find(e => !e.closed);
  if (open && (time - open.end > LIMITS.inactivityMs || open.eventIds.length >= LIMITS.episodeEvents)) {
    await closeEpisode(time - open.end > LIMITS.inactivityMs ? 'Inactivity' : '120-event bound'); open = undefined;
  }
  await db.transaction('rw', [db.events, db.episodes, db.contexts], async () => {
    await db.events.add(event);
    if (event.category === 'page.visibility_change' && !event.visible) return;
    const current: Episode = open ?? { id: crypto.randomUUID(), eventIds: [], tokens: [], start: time, end: time, activeMs: 0, closed: false, reason: 'Recording', gaps: [] };
    const previous = current.eventIds.length ? await db.events.get(current.eventIds[current.eventIds.length - 1]) : undefined;
    const sameForeground = !current.timingBreak && previous?.tabId === event.tabId && previous.visible;
    current.activeMs += sameForeground ? Math.min(LIMITS.intervalCapMs, Math.max(0, time - current.end)) : 0;
    current.timingBreak = false;
    current.end = time; current.eventIds.push(event.id);
    const nextToken = token(event);
    if (current.tokens[current.tokens.length - 1] !== nextToken || !!data || event.category === 'form.submit_attempt' || event.category === 'control.activate' && event.action !== 'unknown') current.tokens.push(nextToken);
    if (data && 'sessionId' in parsed) {
      const record: ContentRecord = { ...data, id: event.id, time, siteId: site.id, episodeId: current.id, document: event.document, sessionId: parsed.sessionId };
      await db.contexts.put(record);
      current.contentFeatures = [...(current.contentFeatures ?? []), { app: site.id, kind: data.kind, label: data.label, terms: contentTerms(data.kind === 'content.display' ? data.text : `${data.label} ${data.after}`), fieldType: data.fieldType }].slice(-120);
    }
    if (previous?.document === event.document && event.sequence > previous.sequence + 1) current.gaps.push('Document sequence gap');
    await db.episodes.put(current);
  });
  if (!event.visible) await closeEpisode('Page hidden');
  await prune();
  return { ok: true };
}
async function summaryFor(workflowId: string) {
  const workflow = await db.workflows.get(workflowId); if (!workflow) throw new Error('Workflow no longer exists');
  return buildSummary(workflow, await db.episodes.toArray(), await db.feedback.toArray(), (await state()).sites, await db.contexts.toArray());
}
function validateReview(review: WorkflowSummary, actual: WorkflowSummary) {
  // Content wording may be redacted; evidence identity, structure, counts, and timing remain code-authoritative.
  const project = (s: WorkflowSummary) => ({ ...s, apps: s.apps.map(a => ({ ...a, alias: '' })), confirmed: s.confirmed.map(c => ({ ...c, text: '' })), occurrences: s.occurrences.map(o => ({ ...o, content: o.content.map(c => ({ ...c, label: '', text: '', before: c.before === null ? null : '', after: '' })) })) });
  if (JSON.stringify(project(review)) !== JSON.stringify(project(actual))) throw new Error('Evidence changed or factual fields edited. Reopen sharing review. Only aliases, correction wording, and content text may be redacted.');
}
const PanelCommand = z.discriminatedUnion('type', [
  z.object({ type: z.literal('status') }).strict(),
  z.object({ type: z.literal('consent.toggle'), enabled: z.boolean() }).strict(),
  z.object({ type: z.literal('content.start'), siteIds: z.array(z.string().uuid()).min(1).max(20), acknowledged: z.literal(true) }).strict(),
  z.object({ type: z.literal('content.stop') }).strict(),
  z.object({ type: z.literal('episode.describe'), id: z.string().uuid(), intent: z.string().trim().min(1).max(1200) }).strict(),
  z.object({ type: z.literal('site.grant'), origin: z.string().max(500) }).strict(),
  z.object({ type: z.literal('site.revoke'), siteId: z.string().uuid() }).strict(),
  z.object({ type: z.literal('site.alias'), siteId: z.string().uuid(), alias: z.string().trim().min(1).max(80) }).strict(),
  z.object({ type: z.literal('episode.end') }).strict(),
  z.object({ type: z.literal('episode.delete'), id: z.string().uuid() }).strict(),
  z.object({ type: z.literal('reset'), retainSites: z.boolean() }).strict(),
  z.object({ type: z.literal('retention'), days: z.number().int().min(1).max(30) }).strict(),
  z.object({ type: z.literal('feedback'), workflowId: z.string().uuid(), kind: z.enum(['intent', 'rule', 'dismiss', 'restore', 'exclude']), text: z.string().trim().max(1200), episodeId: z.string().uuid().optional(), supersedes: z.string().uuid().optional() }).strict(),
  z.object({ type: z.literal('summary'), workflowId: z.string().uuid() }).strict(),
  z.object({ type: z.literal('draft.manual'), workflowId: z.string().uuid() }).strict(),
  z.object({ type: z.literal('draft.save'), definition: z.unknown() }).strict(),
  z.object({ type: z.literal('job.approve'), kind: z.enum(['analysis', 'definition']), payload: z.unknown() }).strict(),
  z.object({ type: z.literal('job.check'), id: z.string().uuid() }).strict(),
  z.object({ type: z.literal('job.update'), id: z.string().uuid(), state: z.enum(['pending', 'running', 'succeeded', 'failed']), result: z.unknown().optional(), error: z.string().max(300).optional() }).strict(),
]);
async function panel(raw: unknown) {
  const cmd = PanelCommand.parse(raw); const consent = await state();
  switch (cmd.type) {
    case 'status': {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      let origin: string | null = null; try { if (tab?.url?.startsWith('http')) origin = new URL(tab.url).origin; } catch { /* no URL */ }
      const approved = consent.sites.find(s => s.origin === origin);
      const collecting = !captureBlocked && consent.enabled && !!approved && tab?.id !== undefined && await foreground(tab.id) && await chrome.permissions.contains({ origins: [approved.pattern] });
      return { consent: captureBlocked ? { ...consent, error: consent.error ?? 'Capture blocked after a storage failure. Reset, or explicitly start after resolving local storage.' } : consent, origin, collecting, contentActive: collecting && !!contentConfig(consent, approved), backend: BACKEND };
    }
    case 'consent.toggle':
      await db.consents.put({ ...consent, enabled: cmd.enabled, epoch: consent.epoch + 1, contentSession: null, error: null });
      if (cmd.enabled) { await chrome.storage.local.set({ captureBlocked: false }); captureBlocked = false; }
      await closeEpisode(cmd.enabled ? 'Observation restarted' : 'Paused'); await reconcile(); return {};
    case 'content.start': {
      const ids = [...new Set(cmd.siteIds)];
      for (const id of ids) {
        const site = consent.sites.find(s => s.id === id);
        if (!site || !await chrome.permissions.contains({ origins: [site.pattern] })) throw new Error('Approve every selected site before content recording');
      }
      await db.consents.put({ ...consent, enabled: true, error: null, epoch: consent.epoch + 1, contentSession: { id: crypto.randomUUID(), siteIds: ids, startedAt: Date.now(), expiresAt: Date.now() + CONTENT_LIMITS.sessionMs } });
      await chrome.storage.local.set({ captureBlocked: false }); captureBlocked = false;
      await closeEpisode('Content-aware session started'); await reconcile(); return {};
    }
    case 'content.stop':
      await db.consents.put({ ...consent, epoch: consent.epoch + 1, contentSession: null });
      await closeEpisode('Content-aware recording stopped'); await reconcile(); return {};
    case 'episode.describe': {
      const episode = await db.episodes.get(cmd.id);
      if (!episode?.closed) throw new Error('Complete the episode first');
      if ((await db.workflows.toArray()).some(w => w.occurrenceIds.includes(episode.id))) throw new Error('This episode already belongs to a pattern; confirm its intent in Patterns');
      const workflowId = crypto.randomUUID();
      await db.transaction('rw', [db.workflows, db.feedback], async () => {
        await db.workflows.add({ id: workflowId, representativeId: episode.id, occurrenceIds: [episode.id], excludedIds: [], score: 0, feedbackVersion: 1, dismissedAtCount: null });
        await db.feedback.add({ id: crypto.randomUUID(), workflowId, version: 1, time: Date.now(), type: 'intent', text: cmd.intent });
      }); return {};
    }
    case 'site.grant': {
      const url = new URL(cmd.origin);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.origin === BACKEND) throw new Error('Only ordinary HTTP(S) sites; backend permission is separate.');
      const pattern = `${url.protocol}//${url.hostname}/*`;
      if (!await chrome.permissions.contains({ origins: [pattern] })) throw new Error('Host permission has not been granted');
      if (!consent.sites.some(s => s.origin === url.origin)) await db.consents.put({ ...consent, epoch: consent.epoch + 1, sites: [...consent.sites, { id: crypto.randomUUID(), origin: url.origin, pattern, alias: `App ${consent.sites.length + 1}` }] });
      await closeEpisode('Consent scope changed', true); await reconcile(); return {};
    }
    case 'site.revoke': {
      const site = consent.sites.find(s => s.id === cmd.siteId);
      await db.consents.put({ ...consent, epoch: consent.epoch + 1, sites: consent.sites.filter(s => s.id !== cmd.siteId) });
      await closeEpisode('Site revoked', true); await reconcile();
      if (site && !site.pattern.includes('127.0.0.1') && !(await state()).sites.some(s => s.pattern === site.pattern)) await chrome.permissions.remove({ origins: [site.pattern] });
      return {};
    }
    case 'site.alias':
      await db.consents.put({ ...consent, sites: consent.sites.map(s => s.id === cmd.siteId ? { ...s, alias: cmd.alias } : s) }); return {};
    case 'episode.end': {
      await closeEpisode('User boundary');
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (tab?.id !== undefined) try { await chrome.tabs.sendMessage(tab.id, { type: 'capture.boundary' }, { frameId: 0 }); } catch { /* No content script. */ }
      return {};
    }
    case 'retention': await db.consents.put({ ...consent, retentionDays: cmd.days }); await prune(); return {};
    case 'episode.delete': {
      const episode = await db.episodes.get(cmd.id); if (!episode) return {};
      await db.transaction('rw', [db.events, db.episodes, db.workflows, db.feedback, db.definitions, db.aiJobs, db.contexts], async () => {
        await db.contexts.where('episodeId').equals(episode.id).delete();
        await db.events.bulkDelete(episode.eventIds); await db.episodes.delete(episode.id);
        for (const w of await db.workflows.toArray()) {
          if (!w.occurrenceIds.includes(episode.id)) continue;
          const ids = w.occurrenceIds.filter(id => id !== episode.id);
          await db.aiJobs.where('workflowId').equals(w.id).delete(); await db.definitions.where('provenance.workflowId').equals(w.id).delete();
          if (!ids.length) { await db.workflows.delete(w.id); await db.feedback.where('workflowId').equals(w.id).delete(); }
          else await db.workflows.put({ ...w, occurrenceIds: ids, representativeId: ids[0], interpretation: undefined, interpretationHistory: [] });
        }
      }); return {};
    }
    case 'reset': {
      await db.consents.put({ ...consent, enabled: false, epoch: consent.epoch + 1, generation: consent.generation + 1, sites: cmd.retainSites ? consent.sites : [], contentSession: null, error: null });
      await reconcile();
      await db.transaction('rw', [db.events, db.episodes, db.workflows, db.feedback, db.definitions, db.aiJobs, db.contexts], async () => {
        for (const table of [db.events, db.episodes, db.workflows, db.feedback, db.definitions, db.aiJobs, db.contexts]) await table.clear();
      });
      await chrome.storage.local.set({ captureBlocked: false }); captureBlocked = false;
      if (!cmd.retainSites) for (const s of consent.sites) if (!s.pattern.includes('127.0.0.1')) await chrome.permissions.remove({ origins: [s.pattern] });
      return {};
    }
    case 'feedback': {
      const w = await db.workflows.get(cmd.workflowId); if (!w) throw new Error('Workflow missing');
      if (['intent', 'rule'].includes(cmd.kind) && !cmd.text) throw new Error('Correction must not be empty');
      if (cmd.kind === 'exclude' && (!cmd.episodeId || !w.occurrenceIds.includes(cmd.episodeId))) throw new Error('Occurrence not in this workflow');
      if (cmd.supersedes) {
        const old = await db.feedback.get(cmd.supersedes);
        if (cmd.kind !== 'rule' || old?.workflowId !== w.id || old.type !== 'rule') throw new Error('Only a rule in this workflow can be corrected');
      }
      await db.transaction('rw', [db.feedback, db.workflows, db.definitions, db.aiJobs], async () => {
        const next = { ...w, feedbackVersion: w.feedbackVersion + 1 };
        await db.feedback.add({ id: crypto.randomUUID(), workflowId: w.id, version: next.feedbackVersion, time: Date.now(), type: cmd.kind, text: cmd.text, episodeId: cmd.episodeId, supersedes: cmd.supersedes });
        if (cmd.kind === 'dismiss') next.dismissedAtCount = w.occurrenceIds.length;
        if (cmd.kind === 'restore') next.dismissedAtCount = null;
        if (cmd.kind === 'exclude') {
          next.occurrenceIds = w.occurrenceIds.filter(id => id !== cmd.episodeId); next.excludedIds = [...w.excludedIds, cmd.episodeId!];
          next.representativeId = next.occurrenceIds[0] ?? '';
          next.interpretationHistory = [...(w.interpretationHistory ?? []), ...(w.interpretation ? [w.interpretation] : [])].slice(-10);
          next.interpretation = undefined;
        }
        await db.workflows.put(next);
        // Corrections invalidate drafts/jobs rather than silently overwrite human edits.
        if (['intent', 'rule', 'exclude'].includes(cmd.kind)) {
          await db.definitions.where('provenance.workflowId').equals(w.id).delete(); await db.aiJobs.where('workflowId').equals(w.id).delete();
        }
      }); return {};
    }
    case 'summary': return await summaryFor(cmd.workflowId);
    case 'draft.manual': {
      const summary = await summaryFor(cmd.workflowId); const definition = makeDefinition(summary, null);
      await db.definitions.add(definition); return definition;
    }
    case 'draft.save': {
      const draft = AgentDefinition.parse(cmd.definition); const old = await db.definitions.get(draft.id);
      if (!old || JSON.stringify(old.provenance) !== JSON.stringify(draft.provenance)) throw new Error('Do not edit evidence provenance; regenerate a draft if evidence changed.');
      const current = await summaryFor(draft.provenance.workflowId);
      if (current.feedbackVersion !== draft.provenance.feedbackVersion || current.occurrenceCount !== draft.provenance.occurrenceCount) throw new Error('Evidence changed. Create a fresh draft.');
      validateDraftGrounding(draft, current);
      const definition = AgentDefinition.parse({ ...draft, version: old.version + 1, savings: { ...draft.savings, assumedSavingsPerOccurrenceMs: Math.max(0, draft.provenance.approximateMeanActiveMs - draft.savings.remainingHumanReviewMs) } });
      await db.definitions.put(definition); return definition;
    }
    case 'job.approve': {
      const payload = cmd.kind === 'analysis' ? WorkflowSummary.parse(cmd.payload) : DefinitionInput.parse(cmd.payload);
      const summary = 'summary' in payload ? payload.summary : payload;
      const actual = await summaryFor(summary.workflowId); validateReview(summary, actual);
      if (cmd.kind === 'analysis' && actual.occurrenceCount < 3) throw new Error('At least three distinct completed occurrences are required for hosted analysis');
      if ('summary' in payload) {
        const w = await db.workflows.get(summary.workflowId);
        if (payload.interpretationVersion !== (w?.interpretation?.version ?? 0) || JSON.stringify(payload.interpretation) !== JSON.stringify(w?.interpretation?.result ?? null)) throw new Error('Interpretation changed. Reopen sharing review.');
      }
      if (new TextEncoder().encode(JSON.stringify({ requestId: crypto.randomUUID(), kind: cmd.kind, payload, approval: true })).length > 47000) throw new Error('Approved request is too large. Shorten content/corrections in the preview or use a manual draft.');
      const payloadHash = await hash(payload);
      const existing = (await db.aiJobs.where('workflowId').equals(summary.workflowId).toArray()).find(j => j.hash === payloadHash && j.kind === cmd.kind && j.state !== 'failed');
      if (existing) return existing;
      const job: AIJob = { id: crypto.randomUUID(), workflowId: summary.workflowId, kind: cmd.kind, generation: consent.generation, payload, hash: payloadHash, evidenceHash: await hash(actual), time: Date.now(), state: 'approved' };
      await db.aiJobs.add(job); return job;
    }
    case 'job.check': {
      const job = await db.aiJobs.get(cmd.id);
      if (!job || job.generation !== consent.generation || ['succeeded', 'failed'].includes(job.state)) throw new Error('Job was invalidated or deleted');
      if (job.evidenceHash !== await hash(await summaryFor(job.workflowId))) {
        await db.aiJobs.update(job.id, { state: 'failed', error: 'Evidence changed; approve a fresh request.' });
        throw new Error('Evidence changed; approve a fresh request.');
      }
      return {};
    }
    case 'job.update': {
      const job = await db.aiJobs.get(cmd.id);
      if (!job || job.generation !== consent.generation) throw new Error('Job was invalidated or deleted');
      if (['succeeded', 'failed'].includes(job.state)) return {};
      if (job.evidenceHash !== await hash(await summaryFor(job.workflowId))) { await db.aiJobs.update(job.id, { state: 'failed', error: 'Evidence changed; approve a fresh request.' }); return {}; }
      if (cmd.state === 'succeeded') {
        const summary = 'summary' in job.payload ? job.payload.summary : job.payload;
        if (job.kind === 'analysis') {
          const result = Interpretation.parse(cmd.result); validateGrounding(result, summary);
          const w = await db.workflows.get(job.workflowId); if (!w) throw new Error('Workflow deleted');
          await db.transaction('rw', [db.workflows, db.aiJobs], async () => {
            const history = [...(w.interpretationHistory ?? []), ...(w.interpretation ? [w.interpretation] : [])].slice(-10);
            const version = Math.max(0, ...history.map(i => i.version)) + 1;
            await db.workflows.put({ ...w, interpretationHistory: history, interpretation: { version, time: Date.now(), result, payloadHash: job.hash, feedbackVersion: summary.feedbackVersion, occurrenceCount: summary.occurrenceCount } });
            await db.aiJobs.update(job.id, { state: 'succeeded' });
          });
        } else {
          const result = DefinitionDraft.parse(cmd.result); validateDraftGrounding(result, summary);
          const input = DefinitionInput.parse(job.payload);
          const definition = makeDefinition(summary, result, input.interpretationVersion);
          await db.transaction('rw', [db.definitions, db.aiJobs], async () => { await db.definitions.add(definition); await db.aiJobs.update(job.id, { state: 'succeeded' }); });
        }
      } else await db.aiJobs.update(job.id, { state: cmd.state, error: cmd.error });
      return {};
    }
  }
}
// Listeners registered synchronously; all mutations (including consent) share one serialized writer lane.
chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  void serial(async () => {
    const envelope = z.object({ type: z.string() }).passthrough().parse(message);
    if (envelope.type.startsWith('capture.')) {
      if (envelope.type === 'capture.event') return await ingest(sender, envelope.payload);
      if (envelope.type === 'capture.context') return await ingest(sender, envelope.payload, true);
      if (envelope.type === 'capture.hello') {
        const c = await state(); const site = await siteFor(sender); return { enabled: !captureBlocked && c.enabled && !!site, epoch: c.epoch, content: contentConfig(c, site) };
      }
      if (envelope.type === 'capture.gap') {
        const c = await state(); if (envelope.epoch === c.epoch && c.enabled && await siteFor(sender)) await closeEpisode('Delivery limit reached', true);
        return {};
      }
      throw new Error('Unsupported capture message');
    }
    if (!trusted(sender)) throw new Error('Only the side panel can manage Observe');
    await prune(); return await panel(message);
  }).then(data => sendResponse({ ok: true, ...data }), async error => {
    await serial(async () => {
      const storageFailure = error instanceof Error && /quota|indexeddb|transaction|database/i.test(error.name + error.message);
      if (storageFailure) {
        captureBlocked = true;
        let durable = false;
        try { await chrome.storage.local.set({ captureBlocked: true }); durable = true; } catch { /* Disk may be wholly unavailable. */ }
        try { const c = await state(); await db.consents.put({ ...c, enabled: false, epoch: c.epoch + 1, contentSession: null, error: 'Local storage write failed. Capture blocked; resolve storage or reset.' }); durable = true; await reconcile(); } catch { /* Ingestion remains blocked. */ }
        await chrome.action.setBadgeText({ text: '!' });
        sendResponse({ ok: false, error: durable ? 'Local storage failed; capture blocked.' : 'Local storage failed. Pause could not be persisted; close approved tabs and reset Observe.' });
      } else sendResponse({ ok: false, error: safeError(error) });
    });
  });
  return true;
});
chrome.permissions.onRemoved.addListener(() => { void serial(reconcile).catch(() => {}); });
chrome.permissions.onAdded.addListener(() => { void serial(reconcile).catch(() => {}); });
chrome.tabs.onActivated.addListener(({ tabId }) => { void serial(async () => {
  await markTimingBreak();
  const tab = await chrome.tabs.get(tabId);
  const c = await state(); const approved = c.sites.some(s => { try { return tab.url && new URL(tab.url).origin === s.origin; } catch { return false; } });
  if (!approved) await closeEpisode('Unobserved tab interval', true);
  // No timing is assigned across tabs; approved cross-app transitions stay in the same episode.
  await updateBadge();
}).catch(() => {}); });
chrome.tabs.onUpdated.addListener((_id, change, tab) => {
  if (!tab.active || !change.status) return;
  void serial(async () => {
    const c = await state(); const approved = c.sites.some(s => { try { return tab.url && new URL(tab.url).origin === s.origin; } catch { return false; } });
    if (!approved) await closeEpisode('Unobserved navigation interval', true);
    await updateBadge();
  }).catch(() => {});
});
chrome.windows.onFocusChanged.addListener(() => { void serial(async () => {
  await markTimingBreak();
  if (!(await chrome.windows.getAll()).some(w => w.focused)) await closeEpisode('Browser unfocused');
  await updateBadge();
}).catch(() => {}); });
chrome.runtime.onInstalled.addListener(() => { void serial(reconcile).catch(() => {}); });
chrome.runtime.onStartup.addListener(() => { void serial(async () => {
  const c = await state(); await db.consents.put({ ...c, contentSession: null, epoch: c.epoch + 1 });
  await closeEpisode('Browser restarted', true); await reconcile();
}).catch(() => {}); });
void serial(async () => {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  if (!await db.consents.get('state')) await db.consents.put(initialConsent());
  captureBlocked = (await chrome.storage.local.get('captureBlocked')).captureBlocked === true;
  await prune(); await reconcile();
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
}).catch(async () => { await chrome.action.setBadgeText({ text: '!' }); });
