import { z } from 'zod';
import { AgentDefinition, ContentData, ContentPayload, DefinitionDraft, DefinitionInput, EventPayload, Interpretation, WorkflowSummary, validateDraftGrounding, validateGrounding, type Episode, type ObservedEvent, type ContentRecord, type PageType, type Triage, type ValueSource, type Workflow } from '../../../packages/core/src/schemas';
import { buildSummary, groupEpisode, LIMITS, localScore, meaningful, token } from '../../../packages/core/src/learning';
import { makeDefinition } from '../../../packages/core/src/definitions';
import { CONTENT_LIMITS, contentTerms, locallySensitiveHost, redactContent, valueSource } from '../../../packages/core/src/privacy';
import { describeEpisode, episodeBrief, JEV_LIMITS, JEV_THRESHOLDS } from '../../../packages/core/src/jev';
import { db, state, hash, initialConsent, type Site, type SiteVerdict, type AIJob } from './storage/db';
import { jevDecide, jevStatus } from './jev';

const BACKEND = 'http://127.0.0.1:4317';
let lane = Promise.resolve();
let captureBlocked = true; // Fail closed until persistent settings have been initialized.
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const task = lane.then(fn); lane = task.then(() => undefined, () => undefined); return task;
}
// Per-document ordering while Jev judges an event outside the writer lane, so sequence order is preserved.
const documentLanes = new Map<string, Promise<unknown>>();
function inDocumentOrder<T>(documentId: string, fn: () => Promise<T>): Promise<T> {
  const task = (documentLanes.get(documentId) ?? Promise.resolve()).then(fn, fn);
  const tail = task.catch(() => undefined);
  documentLanes.set(documentId, tail);
  void tail.then(() => { if (documentLanes.get(documentId) === tail) documentLanes.delete(documentId); });
  return task;
}
const aliasOf = (sites: Site[]) => (id: string) => sites.find(s => s.id === id)?.alias ?? 'Removed app';
const safeError = (e: unknown) => e instanceof Error ? e.message.slice(0, 300) : 'Operation failed';
const trusted = (s: chrome.runtime.MessageSender) => s.id === chrome.runtime.id && s.url === chrome.runtime.getURL('index.html');
const ALL_SITES = ['http://*/*', 'https://*/*'];
function senderOrigin(sender: chrome.runtime.MessageSender): string | undefined {
  if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || sender.tab?.id === undefined || sender.tab.incognito || !sender.url) return;
  try { const url = new URL(sender.url); if (!['http:', 'https:'].includes(url.protocol) || url.origin === BACKEND) return; return url.origin; } catch { return; }
}
const capturable = (site: Site) => !site.blocked && !site.verdict?.sensitive;
/** A site that may be captured right now: known, not blocked, not screened as sensitive, and still permitted by Chrome. */
async function siteFor(sender: chrome.runtime.MessageSender): Promise<Site | undefined> {
  const origin = senderOrigin(sender); if (!origin) return;
  const consent = await state(); const site = consent.sites.find(s => s.origin === origin);
  if (!site || !capturable(site) || !await chrome.permissions.contains({ origins: [site.pattern] })) return;
  return site;
}
async function foreground(tabId: number): Promise<boolean> {
  try { const tab = await chrome.tabs.get(tabId); const win = await chrome.windows.get(tab.windowId); return tab.active === true && win.focused === true; } catch { return false; }
}
async function markTimingBreak() {
  const open = (await db.episodes.toArray()).find(e => !e.closed);
  if (open) await db.episodes.update(open.id, { timingBreak: true });
}
/** All-sites mode: register a newly visited origin, screened by the local list now and by Jev in the background. */
async function ensureSite(sender: chrome.runtime.MessageSender, title: string) {
  const consent = await state(); const origin = senderOrigin(sender);
  if (!consent.allSites || !origin) return;
  let site = consent.sites.find(s => s.origin === origin);
  if (!site) {
    const url = new URL(origin);
    const local = locallySensitiveHost(url.hostname);
    site = { id: crypto.randomUUID(), origin, pattern: `${url.protocol}//${url.hostname}/*`, alias: url.hostname.replace(/^www\./, '').slice(0, 80), auto: true, ...(local ? { verdict: { sensitive: true, category: 'local list', probability: 1, by: 'local' as const, time: Date.now() } } : {}) };
    await db.consents.put({ ...consent, sites: [...consent.sites, site] });
  }
  if (site.auto && !site.verdict) void checkSite(site.id, new URL(origin).hostname, title).catch(() => {});
}
const siteChecks = new Set<string>();
/** Jev screens each discovered site once. Until then capture stays local; a sensitive verdict purges what was stored. */
async function checkSite(siteId: string, hostname: string, title: string) {
  if (siteChecks.has(siteId)) return;
  siteChecks.add(siteId);
  try {
    const decision = await jevDecide({ kind: 'site', hostname, title: redactContent(title, 120).text });
    if (!decision) return;
    await serial(async () => {
      const consent = await state(); const site = consent.sites.find(s => s.id === siteId); if (!site || site.verdict) return;
      const sensitive = decision.sensitive >= JEV_THRESHOLDS.sensitiveSite;
      const verdict: SiteVerdict = { sensitive, category: decision.category, probability: decision.sensitive, by: 'jev', time: Date.now() };
      await db.consents.put({ ...consent, sites: consent.sites.map(s => s.id === siteId ? { ...s, verdict } : s), ...(sensitive ? { epoch: consent.epoch + 1 } : {}) });
      if (sensitive) { await purgeSite(siteId); await reconcile(); }
    });
  } finally { siteChecks.delete(siteId); }
}
async function purgeSite(siteId: string) {
  const open = (await db.episodes.toArray()).find(e => !e.closed);
  const ids = (await db.events.where('siteId').equals(siteId).primaryKeys()) as string[];
  if (open && ids.some(id => open.eventIds.includes(id))) await closeEpisode('Site excluded', true);
  await invalidate(new Set(ids));
}
async function closeEpisode(reason: string, gap = false) {
  const closed = await db.transaction('rw', [db.episodes], async () => {
    const open = (await db.episodes.toArray()).find(e => !e.closed);
    if (!open) return false;
    await db.episodes.put({ ...open, closed: true, reason, gaps: gap ? [...open.gaps, reason] : open.gaps, grouping: 'pending' });
    return true;
  });
  // Triage and grouping may wait on Jev, so they run outside the writer lane and commit back through it.
  if (closed) scheduleGrouping();
}
type Verdict =
  | { kind: 'join'; workflowId: string; probability: number; triage: Triage | null }
  | { kind: 'new'; triage: Triage }
  | { kind: 'local' }
  | { kind: 'discard'; reason: string };
let groupLane: Promise<void> = Promise.resolve();
function scheduleGrouping() { groupLane = groupLane.then(groupPending).catch(() => undefined); }
async function groupPending() {
  const pending = (await db.episodes.toArray()).filter(e => e.closed && e.grouping === 'pending').sort((a, b) => a.start - b.start);
  for (const episode of pending) {
    const verdict = await episodeVerdict(episode);
    const discarded = await serial(() => applyVerdict(episode.id, verdict));
    if (discarded) {
      const day = new Date().toISOString().slice(0, 10); const { discards } = await chrome.storage.local.get('discards') as { discards?: { day: string; count: number } };
      await chrome.storage.local.set({ discards: { day, count: (discards?.day === day ? discards.count : 0) + 1 } });
    }
  }
}
/**
 * One pass: a match to an existing pattern saves the episode as a repeat. Otherwise Jev triage decides whether it is
 * routine work worth keeping as a candidate. Without Jev, local rules keep any meaningful episode.
 */
async function episodeVerdict(episode: Episode): Promise<Verdict> {
  if (!meaningful(episode)) return { kind: 'discard', reason: 'Navigation or unrecognized actions only' };
  const [events, contexts, consent] = await Promise.all([db.events.bulkGet(episode.eventIds), db.contexts.where('episodeId').equals(episode.id).toArray(), state()]);
  const own = events.filter((e): e is ObservedEvent => !!e);
  const alias = aliasOf(consent.sites);
  const match = await matchDecision(episode, own);
  if (match?.candidateId) return { kind: 'join', workflowId: match.candidateId, probability: match.probability, triage: null };
  const decision = await jevDecide({ kind: 'triage', episode: episodeBrief(episode, contexts, alias, own) });
  if (!decision) return { kind: 'local' };
  const triage: Triage = { work: decision.work, routine: decision.routine, automatable: decision.automatable, by: 'jev' };
  if (decision.work >= JEV_THRESHOLDS.work && decision.routine >= JEV_THRESHOLDS.routine) return { kind: 'new', triage };
  return { kind: 'discard', reason: `Jev: not routine work (work ${Math.round(decision.work * 100)}%, routine ${Math.round(decision.routine * 100)}%)` };
}
/** Returns true when the episode was discarded. Saved episodes keep only the evidence a summary or playbook needs. */
async function applyVerdict(episodeId: string, verdict: Verdict): Promise<boolean> {
  return db.transaction('rw', [db.episodes, db.workflows, db.events, db.contexts], async () => {
    const current = await db.episodes.get(episodeId);
    if (!current || current.grouping !== 'pending') return false; // Deleted, reset, or already described.
    const workflows = await db.workflows.toArray();
    if (workflows.some(w => w.occurrenceIds.includes(current.id))) { await db.episodes.update(current.id, { grouping: 'done' }); return false; }
    let grouped: Workflow | null = null;
    const target = verdict.kind === 'join' ? workflows.find(w => w.id === verdict.workflowId && !w.excludedIds.includes(current.id)) : undefined;
    if (verdict.kind === 'join' && target) grouped = { ...target, occurrenceIds: [...target.occurrenceIds, current.id], score: verdict.probability, matchedBy: 'jev' };
    else if (verdict.kind === 'new') grouped = { id: crypto.randomUUID(), representativeId: current.id, occurrenceIds: [current.id], excludedIds: [], score: 1, feedbackVersion: 0, dismissedAtCount: null, matchedBy: 'jev', candidate: verdict.triage };
    else if (verdict.kind === 'local' || verdict.kind === 'join') grouped = groupEpisode(current, workflows, await db.episodes.toArray());
    if (!grouped) {
      await db.contexts.where('episodeId').equals(current.id).delete();
      await db.events.bulkDelete(current.eventIds); await db.episodes.delete(current.id);
      return true;
    }
    await db.workflows.put(grouped);
    await trimEvidence(current.id);
    await db.episodes.update(current.id, { grouping: 'done', ...(verdict.kind === 'new' ? { triage: verdict.triage } : {}) });
    return false;
  });
}
/** Keep field edits, outcomes, and the latest display per page type; drop the rest of an episode's captured text. */
async function trimEvidence(episodeId: string) {
  const records = (await db.contexts.where('episodeId').equals(episodeId).toArray()).sort((a, b) => b.time - a.time);
  const keep = new Set<string>(); const pageTypes = new Set<string>();
  for (const r of records) {
    if (r.kind === 'field.edit' && [...keep].length < 30 || r.outcomeOf) keep.add(r.id);
    else if (r.kind === 'content.display' && pageTypes.size < 5 && !pageTypes.has(r.pageType ?? 'unknown')) { pageTypes.add(r.pageType ?? 'unknown'); keep.add(r.id); }
  }
  await db.contexts.bulkDelete(records.filter(r => !keep.has(r.id)).map(r => r.id));
}
/** Jev picks among locally shortlisted patterns. Null means no confident match. */
async function matchDecision(episode: Episode, events: ObservedEvent[]): Promise<{ candidateId: string | null; probability: number } | null> {
  const [workflows, episodes, contexts, feedback, consent] = await Promise.all([db.workflows.toArray(), db.episodes.toArray(), db.contexts.toArray(), db.feedback.toArray(), state()]);
  const byId = new Map(episodes.map(e => [e.id, e]));
  const shortlist = workflows
    .filter(w => !w.excludedIds.includes(episode.id) && !w.occurrenceIds.includes(episode.id) && byId.has(w.representativeId))
    .map(w => ({ w, score: localScore(episode, byId.get(w.representativeId)!) }))
    .sort((a, b) => b.score - a.score).slice(0, JEV_LIMITS.candidates);
  if (!shortlist.length) return null;
  const alias = aliasOf(consent.sites);
  const repEvents = (await db.events.bulkGet(shortlist.flatMap(({ w }) => byId.get(w.representativeId)!.eventIds))).filter((e): e is ObservedEvent => !!e);
  const purpose = (w: Workflow) => feedback.filter(f => f.workflowId === w.id && f.type === 'intent').sort((a, b) => b.version - a.version)[0]?.text ?? w.interpretation?.result.name ?? null;
  const candidates = shortlist.map(({ w }) => ({ id: w.id, purpose: purpose(w), brief: episodeBrief(byId.get(w.representativeId)!, contexts, alias, repEvents) }));
  const request = { kind: 'match' as const, episode: episodeBrief(episode, contexts, alias, events), candidates };
  // Stay under the backend's 48 KiB body limit by dropping the lowest-ranked candidates.
  while (candidates.length > 1 && new TextEncoder().encode(JSON.stringify(request)).length > 44000) candidates.pop();
  const decision = await jevDecide(request);
  return decision && decision.probability >= JEV_THRESHOLDS.match ? { candidateId: decision.candidateId, probability: decision.probability } : null;
}
/** Jev may close a clearly finished task; less certain results are shown as a suggestion. */
async function checkBoundary(episodeId: string) {
  const episode = await db.episodes.get(episodeId); if (!episode || episode.closed) return;
  const [contexts, events, consent] = await Promise.all([db.contexts.where('episodeId').equals(episodeId).toArray(), db.events.bulkGet(episode.eventIds), state()]);
  const decision = await jevDecide({ kind: 'boundary', episode: episodeBrief(episode, contexts, aliasOf(consent.sites), events.filter((e): e is ObservedEvent => !!e)) });
  if (!decision) return;
  await serial(async () => {
    const current = await db.episodes.get(episodeId); if (!current || current.closed) return;
    if (decision.finished >= JEV_THRESHOLDS.autoClose) await closeEpisode(`Task finished (Jev ${Math.round(decision.finished * 100)}%)`);
    else await db.episodes.update(episodeId, { boundarySuggestion: { probability: decision.finished, eventCount: current.eventIds.length, time: Date.now() } });
  });
}
function contentConfig(consent: Awaited<ReturnType<typeof state>>, site?: Site) {
  return !captureBlocked && consent.enabled && consent.contentEnabled && site && capturable(site) ? { id: consent.contentSessionId } : null;
}
async function reconcile() {
  let consent = await state();
  const registered = await chrome.scripting.getRegisteredContentScripts();
  if (consent.allSites && !await chrome.permissions.contains({ origins: ALL_SITES })) {
    consent = { ...consent, allSites: false, epoch: consent.epoch + 1 };
    await db.consents.put(consent); await closeEpisode('All-sites permission removed', true);
  }
  const desired: Site[] = [];
  for (const site of consent.sites) if (await chrome.permissions.contains({ origins: [site.pattern] })) desired.push(site);
  if (desired.length !== consent.sites.length) {
    await db.consents.put({ ...consent, sites: desired, epoch: consent.epoch + 1 });
    await closeEpisode('Permission removed', true);
  }
  // All-sites mode uses one registration; per-site mode one per approved origin.
  const wanted = consent.allSites ? ['observe-all'] : desired.map(s => `observe-${s.id}`);
  const stale = registered.filter(r => r.id.startsWith('observe-') && !wanted.includes(r.id));
  if (stale.length) await chrome.scripting.unregisterContentScripts({ ids: stale.map(s => s.id) });
  const fresh = consent.allSites
    ? (registered.some(r => r.id === 'observe-all') ? [] : [{ id: 'observe-all', matches: ALL_SITES, excludeMatches: [`${BACKEND}/*`] }])
    : desired.filter(s => !registered.some(r => r.id === `observe-${s.id}`)).map(s => ({ id: `observe-${s.id}`, matches: [s.pattern], excludeMatches: [] as string[] }));
  if (fresh.length) await chrome.scripting.registerContentScripts(fresh.map(s => ({ ...s, js: ['content.js'], runAt: 'document_idle' as const, allFrames: false, persistAcrossSessions: true })));
  const tabs = await chrome.tabs.query({}); const current = await state();
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    let origin: string | undefined; try { const url = new URL(tab.url ?? ''); if (['http:', 'https:'].includes(url.protocol) && url.origin !== BACKEND) origin = url.origin; } catch { /* No URL access. */ }
    const site = current.sites.find(s => s.origin === origin);
    if (site || current.allSites && origin) {
      try { await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, files: ['content.js'] }); } catch { /* Unsupported page: no capture. */ }
    }
    try { await chrome.tabs.sendMessage(tab.id, { type: 'capture.config', enabled: !captureBlocked && current.enabled && !!site && capturable(site), epoch: current.epoch, content: contentConfig(current, site) }, { frameId: 0 }); } catch { /* No content script. */ }
  }
  await updateBadge();
}
async function updateBadge() {
  const consent = await state(); const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const site = consent.sites.find(s => { try { return tab?.url && new URL(tab.url).origin === s.origin; } catch { return false; } });
  const collecting = !captureBlocked && consent.enabled && !!site && capturable(site) && tab?.id !== undefined && await foreground(tab.id) && await chrome.permissions.contains({ origins: [site.pattern] });
  await chrome.action.setBadgeText({ text: consent.error ? '!' : collecting ? contentConfig(consent, site) ? 'TXT' : 'ON' : site && !capturable(site) ? 'SKIP' : consent.enabled ? '—' : 'OFF' });
  await chrome.action.setBadgeBackgroundColor({ color: consent.error ? '#b74141' : collecting ? '#24856a' : '#67727f' });
}
/** Removes events and every episode, pattern occurrence, draft, and job that depended on them. */
async function invalidate(old: Set<string>) {
  if (!old.size) return;
  await db.transaction('rw', [db.events, db.episodes, db.workflows, db.feedback, db.definitions, db.aiJobs, db.contexts], async () => {
    const episodes = await db.episodes.toArray();
    const invalid = new Set(episodes.filter(e => e.eventIds.some(id => old.has(id))).map(e => e.id));
    // Whole affected episodes and dependent records are invalidated, never preserve unsupported counts.
    const removed = episodes.filter(e => invalid.has(e.id));
    const deleted = [...new Set([...old, ...removed.flatMap(e => e.eventIds)])];
    await db.events.bulkDelete(deleted); await db.contexts.bulkDelete(deleted);
    for (const id of invalid) await db.contexts.where('episodeId').equals(id).delete();
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
async function prune() {
  const consent = await state(); const now = Date.now();
  const [episodes, workflows] = await Promise.all([db.episodes.toArray(), db.workflows.toArray()]);
  // Unsaved captured text expires after 24 hours or beyond the cap, without invalidating episodes.
  const saved = new Set(workflows.flatMap(w => w.occurrenceIds));
  const contexts = await db.contexts.orderBy('time').toArray();
  const overflow = Math.max(0, contexts.length - CONTENT_LIMITS.recordCap);
  const dropContent = contexts.filter((c, i) => !saved.has(c.episodeId) && (c.time < now - CONTENT_LIMITS.retentionMs || i < overflow)).map(c => c.id);
  if (dropContent.length) await db.contexts.bulkDelete(dropContent);
  // Candidates seen once expire unless pinned or repeated.
  const byId = new Map(episodes.map(e => [e.id, e]));
  const expired = workflows.filter(w => !w.pinned && w.occurrenceIds.length === 1 && (byId.get(w.occurrenceIds[0])?.end ?? 0) < now - LIMITS.candidateTtlDays * 86400000);
  const events = await db.events.orderBy('time').toArray();
  const cutoff = now - consent.retentionDays * 86400000;
  await invalidate(new Set([
    ...events.filter((e, i) => e.time < cutoff || i < events.length - LIMITS.eventCap).map(e => e.id),
    ...expired.flatMap(w => byId.get(w.occurrenceIds[0])?.eventIds ?? []),
  ]));
}
type Prepared =
  | { kind: 'event'; payload: Omit<z.infer<typeof EventPayload>, 'hint' | 'route'>; target?: string; route?: string }
  | { kind: 'content'; parsed: z.infer<typeof ContentPayload>; data: ContentData; relevance: number | null; pageType: PageType | null; provenance?: ValueSource; outcomeOf?: string; outcome: number | null }
  | { kind: 'drop' };
/** Read-only consent gate. Checked before any Jev call and again inside the writer lane before commit. */
async function allowed(sender: chrome.runtime.MessageSender, epoch: number, visible: boolean, category: string): Promise<Site | undefined> {
  const consent = await state(); const site = await siteFor(sender);
  if (captureBlocked || !site || !consent.enabled || epoch !== consent.epoch) return;
  if (!await foreground(sender.tab!.id!)) return;
  if (!visible && category !== 'page.visibility_change') return;
  return site;
}
async function recentActivity(): Promise<string[]> {
  const open = (await db.episodes.toArray()).find(e => !e.closed); if (!open) return [];
  const events = (await db.events.bulkGet(open.eventIds.slice(-15))).filter((e): e is ObservedEvent => !!e);
  return describeEpisode(open, events, aliasOf((await state()).sites)).slice(-10).map(l => l.slice(0, 240));
}
const contentAllowed = (consent: Awaited<ReturnType<typeof state>>, sessionId: string) => consent.contentEnabled && sessionId === consent.contentSessionId;
// The next page snapshot after a submit/save/send in the same tab is treated as that action's outcome.
const outcomes = new Map<number, { eventId: string; time: number }>();
let lastCapturePrune = 0;
const OUTCOME_ACTIONS = ['save', 'send', 'reply', 'delete', 'add'];
/** Redacts and, when allowed, asks Jev to classify clicks and judge captured content. Runs outside the writer lane. */
async function prepare(sender: chrome.runtime.MessageSender, raw: unknown, enriched: boolean): Promise<Prepared> {
  if (!enriched) {
    const { hint, route, ...payload } = EventPayload.parse(raw);
    const target = payload.category === 'control.activate' && hint ? redactContent(hint, 80).text.trim() || undefined : undefined;
    const extras = { target, route: route ? redactContent(route, 200).text : undefined };
    if (payload.category !== 'control.activate' || payload.action !== 'unknown' || !target) return { kind: 'event', payload, ...extras };
    if (!await allowed(sender, payload.epoch, payload.visible, payload.category)) return { kind: 'event', payload, ...extras };
    const decision = await jevDecide({ kind: 'action', control: { role: payload.role === 'link' ? 'link' : 'button', label: target }, recent: await recentActivity() });
    return { kind: 'event', payload: decision && decision.action !== 'unknown' && decision.probability >= JEV_THRESHOLDS.action ? { ...payload, action: decision.action } : payload, ...extras };
  }
  const parsed = ContentPayload.parse(raw);
  const text = redactContent(parsed.data.text, CONTENT_LIMITS.excerptChars), after = redactContent(parsed.data.after, CONTENT_LIMITS.fieldChars);
  const before = parsed.data.before === null ? null : redactContent(parsed.data.before, CONTENT_LIMITS.fieldChars);
  const label = redactContent(parsed.data.label, CONTENT_LIMITS.labelChars);
  const data = ContentData.parse({ ...parsed.data, text: text.text, after: after.text, before: before?.text ?? null, label: label.text, redactions: parsed.data.redactions + text.redactions + after.redactions + (before?.redactions ?? 0) + label.redactions, truncated: parsed.data.truncated || text.truncated || after.truncated || (before?.truncated ?? false) });
  if (data.kind === 'content.display' && !data.text.trim() || data.kind === 'field.edit' && data.before === data.after) return { kind: 'drop' };
  const site = await allowed(sender, parsed.epoch, parsed.visible, data.kind);
  if (!site || !contentAllowed(await state(), parsed.sessionId)) return { kind: 'content', parsed, data, relevance: null, pageType: null, outcome: null };
  const tabId = sender.tab!.id!; const pending = outcomes.get(tabId);
  const outcomeOf = data.kind === 'content.display' && pending && Date.now() - pending.time < 15000 ? pending.eventId : undefined;
  if (outcomeOf) outcomes.delete(tabId);
  let provenance: ValueSource | undefined;
  if (data.kind === 'field.edit') {
    const open = (await db.episodes.toArray()).find(e => !e.closed);
    const displays = open ? (await db.contexts.where('episodeId').equals(open.id).toArray()).filter(c => c.kind === 'content.display').sort((a, b) => a.time - b.time).slice(-10) : [];
    provenance = valueSource(data.after, displays.map(d => ({ id: d.id, text: d.text })));
  }
  const decision = await jevDecide({ kind: 'relevance', recent: await recentActivity(), outcomeCheck: !!outcomeOf, content: { kind: data.kind, label: data.label, text: data.text, before: data.before, after: data.after } });
  // Boilerplate and likely-sensitive content is never stored when Jev can judge it. Outcome snapshots are kept unless sensitive.
  if (decision && (decision.sensitive >= JEV_THRESHOLDS.sensitive || !outcomeOf && decision.relevant < JEV_THRESHOLDS.relevant)) return { kind: 'drop' };
  return { kind: 'content', parsed, data, relevance: decision?.relevant ?? null, pageType: decision?.pageType ?? null, provenance, outcomeOf, outcome: decision?.succeeded ?? null };
}
async function ingest(sender: chrome.runtime.MessageSender, prepared: Prepared) {
  if (prepared.kind === 'drop') return { ok: true };
  const parsed = prepared.kind === 'content' ? prepared.parsed : null;
  const payload = parsed ? { id: parsed.id, document: parsed.document, sequence: parsed.sequence, epoch: parsed.epoch, visible: parsed.visible, category: parsed.data.kind, action: 'unknown' as const, role: parsed.data.kind === 'content.display' ? 'page' as const : 'unknown' as const } : (prepared as Extract<Prepared, { kind: 'event' }>).payload;
  const site = await allowed(sender, payload.epoch, payload.visible, payload.category);
  if (!site) return { ok: false, disabled: true };
  const data = prepared.kind === 'content' ? prepared.data : undefined;
  if (parsed && !contentAllowed(await state(), parsed.sessionId)) return { ok: false, disabled: true };
  const time = Date.now(); // Never accept a page-provided timestamp.
  const extras = prepared.kind === 'event' ? { ...(prepared.target ? { target: prepared.target } : {}), ...(prepared.route ? { route: prepared.route } : {}) } : {};
  const event: ObservedEvent = { ...payload, ...extras, time, siteId: site.id, tabId: sender.tab!.id!, ...(data ? { contextRef: payload.id } : {}) };
  if (await db.events.get(event.id) || await db.events.where('[document+sequence]').equals([event.document, event.sequence]).count()) return { ok: true };
  let open = (await db.episodes.toArray()).find(e => !e.closed);
  if (open && (time - open.end > LIMITS.inactivityMs || open.eventIds.length >= LIMITS.episodeEvents)) {
    await closeEpisode(time - open.end > LIMITS.inactivityMs ? 'Inactivity' : '120-event bound'); open = undefined;
  }
  let episodeId: string | undefined;
  await db.transaction('rw', [db.events, db.episodes, db.contexts], async () => {
    await db.events.add(event);
    if (event.category === 'page.visibility_change' && !event.visible) return;
    const current: Episode = open ?? { id: crypto.randomUUID(), eventIds: [], tokens: [], start: time, end: time, activeMs: 0, closed: false, reason: 'Recording', gaps: [] };
    episodeId = current.id;
    const previous = current.eventIds.length ? await db.events.get(current.eventIds[current.eventIds.length - 1]) : undefined;
    const sameForeground = !current.timingBreak && previous?.tabId === event.tabId && previous.visible;
    current.activeMs += sameForeground ? Math.min(LIMITS.intervalCapMs, Math.max(0, time - current.end)) : 0;
    current.timingBreak = false;
    current.end = time; current.eventIds.push(event.id);
    const nextToken = token(event);
    if (current.tokens[current.tokens.length - 1] !== nextToken || !!data || event.category === 'form.submit_attempt' || event.category === 'control.activate' && event.action !== 'unknown') current.tokens.push(nextToken);
    if (data && parsed && prepared.kind === 'content') {
      const record: ContentRecord = {
        ...data, id: event.id, time, siteId: site.id, episodeId: current.id, document: event.document, sessionId: parsed.sessionId,
        relevance: prepared.relevance, pageType: prepared.pageType, outcome: prepared.outcome,
        ...(prepared.provenance ? { provenance: prepared.provenance } : {}), ...(prepared.outcomeOf ? { outcomeOf: prepared.outcomeOf } : {}),
      };
      await db.contexts.put(record);
      current.contentFeatures = [...(current.contentFeatures ?? []), { app: site.id, kind: data.kind, label: data.label, terms: contentTerms(data.kind === 'content.display' ? data.text : `${data.label} ${data.after}`), fieldType: data.fieldType }].slice(-120);
    }
    if (previous?.document === event.document && event.sequence > previous.sequence + 1) current.gaps.push('Document sequence gap');
    await db.episodes.put(current);
  });
  const finishing = event.category === 'form.submit_attempt' || event.category === 'control.activate' && OUTCOME_ACTIONS.includes(event.action);
  if (finishing) outcomes.set(event.tabId, { eventId: event.id, time });
  if (!event.visible) await closeEpisode('Page hidden');
  else if (episodeId && finishing) void checkBoundary(episodeId).catch(() => {});
  // Always-on capture produces many events; retention cleanup on this path runs at most once a minute.
  if (Date.now() - lastCapturePrune > 60000) { lastCapturePrune = Date.now(); await prune(); }
  return { ok: true };
}
async function summaryFor(workflowId: string) {
  const workflow = await db.workflows.get(workflowId); if (!workflow) throw new Error('Workflow no longer exists');
  const episodes = await db.episodes.toArray();
  const events = (await db.events.bulkGet(episodes.filter(e => workflow.occurrenceIds.includes(e.id)).flatMap(e => e.eventIds))).filter((e): e is ObservedEvent => !!e);
  return buildSummary(workflow, episodes, await db.feedback.toArray(), (await state()).sites, await db.contexts.toArray(), events);
}
function validateReview(review: WorkflowSummary, actual: WorkflowSummary) {
  // Content wording may be redacted; evidence identity, structure, counts, and timing remain code-authoritative.
  const project = (s: WorkflowSummary) => ({ ...s, apps: s.apps.map(a => ({ ...a, alias: '' })), confirmed: s.confirmed.map(c => ({ ...c, text: '' })), occurrences: s.occurrences.map(o => ({ ...o, content: o.content.map(c => ({ ...c, label: '', text: '', before: c.before === null ? null : '', after: '' })) })) });
  if (JSON.stringify(project(review)) !== JSON.stringify(project(actual))) throw new Error('Evidence changed or factual fields edited. Reopen sharing review. Only aliases, correction wording, and content text may be redacted.');
}
const PanelCommand = z.discriminatedUnion('type', [
  z.object({ type: z.literal('status') }).strict(),
  z.object({ type: z.literal('consent.toggle'), enabled: z.boolean() }).strict(),
  z.object({ type: z.literal('content.toggle'), enabled: z.boolean() }).strict(),
  z.object({ type: z.literal('allsites.set'), enabled: z.boolean() }).strict(),
  z.object({ type: z.literal('site.block'), siteId: z.string().uuid(), blocked: z.boolean() }).strict(),
  z.object({ type: z.literal('workflow.pin'), workflowId: z.string().uuid(), pinned: z.boolean() }).strict(),
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
      const site = consent.sites.find(s => s.origin === origin);
      const collecting = !captureBlocked && consent.enabled && !!site && capturable(site) && tab?.id !== undefined && await foreground(tab.id) && await chrome.permissions.contains({ origins: [site.pattern] });
      const { discards } = await chrome.storage.local.get('discards') as { discards?: { day: string; count: number } };
      return {
        consent: captureBlocked ? { ...consent, error: consent.error ?? 'Capture blocked after a storage failure. Reset, or explicitly start after resolving local storage.' } : consent,
        origin, collecting, contentActive: collecting && !!contentConfig(consent, site), backend: BACKEND, jev: jevStatus(),
        discardedToday: discards?.day === new Date().toISOString().slice(0, 10) ? discards.count : 0,
      };
    }
    case 'consent.toggle':
      await db.consents.put({ ...consent, enabled: cmd.enabled, epoch: consent.epoch + 1, error: null });
      if (cmd.enabled) { await chrome.storage.local.set({ captureBlocked: false }); captureBlocked = false; }
      await closeEpisode(cmd.enabled ? 'Observation restarted' : 'Paused'); await reconcile(); return {};
    case 'content.toggle':
      // A new session ID ensures text captured under the old setting can never be committed later.
      await db.consents.put({ ...consent, contentEnabled: cmd.enabled, contentSessionId: crypto.randomUUID(), epoch: consent.epoch + 1 });
      await closeEpisode(cmd.enabled ? 'Page text capture on' : 'Page text capture off'); await reconcile(); return {};
    case 'allsites.set': {
      if (cmd.enabled && !await chrome.permissions.contains({ origins: ALL_SITES })) throw new Error('Allow access to all websites first.');
      // Turning all-sites off keeps manually approved sites only; discovered sites lose their permission.
      const sites = cmd.enabled ? consent.sites : consent.sites.filter(s => !s.auto);
      await db.consents.put({ ...consent, allSites: cmd.enabled, sites, ...(cmd.enabled ? { enabled: true, error: null } : {}), epoch: consent.epoch + 1 });
      if (cmd.enabled) { await chrome.storage.local.set({ captureBlocked: false }); captureBlocked = false; }
      await closeEpisode(cmd.enabled ? 'All-sites recording on' : 'All-sites recording off', true); await reconcile(); return {};
    }
    case 'site.block': {
      if (!consent.sites.some(s => s.id === cmd.siteId)) throw new Error('Unknown site');
      await db.consents.put({ ...consent, sites: consent.sites.map(s => s.id === cmd.siteId ? { ...s, blocked: cmd.blocked } : s), epoch: consent.epoch + 1 });
      if (cmd.blocked) await purgeSite(cmd.siteId);
      await reconcile(); return {};
    }
    case 'workflow.pin': {
      const w = await db.workflows.get(cmd.workflowId); if (!w) throw new Error('Workflow missing');
      await db.workflows.update(w.id, { pinned: cmd.pinned }); return {};
    }
    case 'episode.describe': {
      const episode = await db.episodes.get(cmd.id);
      if (!episode?.closed) throw new Error('Complete the episode first');
      if ((await db.workflows.toArray()).some(w => w.occurrenceIds.includes(episode.id))) throw new Error('This episode already belongs to a pattern; confirm its intent in Patterns');
      const workflowId = crypto.randomUUID();
      await db.transaction('rw', [db.workflows, db.feedback, db.episodes], async () => {
        await db.workflows.add({ id: workflowId, representativeId: episode.id, occurrenceIds: [episode.id], excludedIds: [], score: 0, feedbackVersion: 1, dismissedAtCount: null });
        await db.episodes.update(episode.id, { grouping: 'done' });
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
      if (site && !site.auto && !site.pattern.includes('127.0.0.1') && !(await state()).sites.some(s => s.pattern === site.pattern)) await chrome.permissions.remove({ origins: [site.pattern] });
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
      await db.consents.put({ ...consent, enabled: false, epoch: consent.epoch + 1, generation: consent.generation + 1, sites: cmd.retainSites ? consent.sites : [], allSites: cmd.retainSites && consent.allSites, error: null });
      await reconcile();
      await db.transaction('rw', [db.events, db.episodes, db.workflows, db.feedback, db.definitions, db.aiJobs, db.contexts], async () => {
        for (const table of [db.events, db.episodes, db.workflows, db.feedback, db.definitions, db.aiJobs, db.contexts]) await table.clear();
      });
      await chrome.storage.local.set({ captureBlocked: false }); captureBlocked = false;
      if (!cmd.retainSites) {
        for (const s of consent.sites) if (!s.auto && !s.pattern.includes('127.0.0.1')) await chrome.permissions.remove({ origins: [s.pattern] });
        if (consent.allSites) await chrome.permissions.remove({ origins: ALL_SITES });
      }
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
  const envelope = z.object({ type: z.string(), payload: z.object({ document: z.string().max(100) }).passthrough().optional() }).passthrough().safeParse(message);
  const captured = envelope.success && (envelope.data.type === 'capture.event' || envelope.data.type === 'capture.context') ? envelope.data : null;
  // Captured events are judged by Jev outside the writer lane, in per-document order, then committed serially.
  const work: Promise<object> = captured ? inDocumentOrder(captured.payload?.document ?? 'unknown', async () => {
    const prepared = await prepare(sender, captured.payload, captured.type === 'capture.context');
    return serial(() => ingest(sender, prepared));
  }) : serial(async () => {
    const envelope = z.object({ type: z.string() }).passthrough().parse(message);
    if (envelope.type.startsWith('capture.')) {
      if (envelope.type === 'capture.hello') {
        await ensureSite(sender, typeof envelope.title === 'string' ? envelope.title.slice(0, 120) : '');
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
  });
  void work.then(data => sendResponse({ ok: true, ...data }), async error => {
    await serial(async () => {
      const storageFailure = error instanceof Error && /quota|indexeddb|transaction|database/i.test(error.name + error.message);
      if (storageFailure) {
        captureBlocked = true;
        let durable = false;
        try { await chrome.storage.local.set({ captureBlocked: true }); durable = true; } catch { /* Disk may be wholly unavailable. */ }
        try { const c = await state(); await db.consents.put({ ...c, enabled: false, epoch: c.epoch + 1, error: 'Local storage write failed. Capture blocked; resolve storage or reset.' }); durable = true; await reconcile(); } catch { /* Ingestion remains blocked. */ }
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
  const c = await state(); await db.consents.put({ ...c, epoch: c.epoch + 1 });
  await closeEpisode('Browser restarted', true); await reconcile();
}).catch(() => {}); });
void serial(async () => {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  if (!await db.consents.get('state')) await db.consents.put(initialConsent());
  captureBlocked = (await chrome.storage.local.get('captureBlocked')).captureBlocked === true;
  await prune(); await reconcile();
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  scheduleGrouping(); // Resume grouping interrupted by worker termination.
}).catch(async () => { await chrome.action.setBadgeText({ text: '!' }); });
