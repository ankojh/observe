import type { ContentRecord, Episode, Feedback, ObservedEvent, Workflow, WorkflowSummary } from './schemas';
import { WorkflowSummary as SummarySchema } from './schemas';
import { contentTerms, termSimilarity } from './privacy';

export const LIMITS = { inactivityMs: 120_000, intervalCapMs: 30_000, episodeEvents: 120, retentionDays: 7, eventCap: 10_000, similarity: 0.76, contentSimilarity: 0.72 };
export function token(event: ObservedEvent): string { return `${event.siteId}|${event.category}|${event.action}`; }
const weight = (t: string) => /\|(field.edit|form.submit_attempt)\|/.test(t) ? 1.5 : t.includes('|content.display|') ? 1.2 : t.endsWith('|unknown') ? 0.35 : t.includes('|control.activate|') ? 1.5 : 0.6;
/** Weighted normalized edit distance. Max 120 tokens per episode: O(120²). Not a probability. */
export function similarity(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  let prev = [0]; for (const t of b) prev.push(prev[prev.length - 1] + weight(t));
  for (let i = 0; i < a.length; i++) {
    const next = [prev[0] + weight(a[i])];
    for (let j = 0; j < b.length; j++) {
      const substitution = a[i] === b[j] ? 0 : Math.max(weight(a[i]), weight(b[j]));
      next.push(Math.min(prev[j + 1] + weight(a[i]), next[j] + weight(b[j]), prev[j] + substitution));
    }
    prev = next;
  }
  return Math.max(0, 1 - prev[b.length] / Math.max(a.reduce((n, t) => n + weight(t), 0), b.reduce((n, t) => n + weight(t), 0)));
}
export function eligibility(episode: Episode): { eligible: boolean; content: boolean; reason: string } {
  if (!episode.closed) return { eligible: false, content: false, reason: 'Recording: end the episode before matching.' };
  const features = episode.contentFeatures ?? [];
  const hasContent = features.some(f => f.kind === 'content.display' ? f.terms.length >= 4 : f.terms.length >= 1);
  if (hasContent) return { eligible: true, content: true, reason: 'Content-supported candidate. Display is observed; reading and business intent remain unverified.' };
  const actions = episode.tokens.filter(t => t.includes('|form.submit_attempt|') || t.includes('|control.activate|') && !t.endsWith('|unknown')).length;
  if (actions >= 2) return { eligible: true, content: false, reason: 'Action-supported candidate; business purpose is unknown.' };
  return { eligible: false, content: false, reason: features.length ? 'Captured content has too little usable language after redaction. Add context or create a user-described draft.' : 'Only navigation, unknown controls, or too few recognized actions. Enable content-aware recording; old episodes cannot recover text retroactively.' };
}
export function meaningful(episode: Episode): boolean { return eligibility({ ...episode, closed: true }).eligible; }
function contentMatch(a: Episode, b: Episode): number {
  const left = a.contentFeatures ?? [], right = b.contentFeatures ?? [];
  const pageTerms = (features: typeof left) => features.filter(f => f.kind === 'content.display').flatMap(f => f.terms);
  const editTerms = (features: typeof left) => features.filter(f => f.kind === 'field.edit').flatMap(f => [...f.terms, ...contentTerms(f.label)]);
  const lp = pageTerms(left), rp = pageTerms(right), le = editTerms(left), re = editTerms(right);
  const pageScore = termSimilarity(lp, rp), editScore = termSimilarity(le, re);
  const semantic = lp.length && rp.length ? pageScore * (le.length && re.length ? 0.7 : 1) + (le.length && re.length ? editScore * 0.3 : 0) : editScore;
  // Repeated field shape/site order alone is insufficient; require shared content vocabulary.
  if (semantic < 0.38) return 0;
  const important = (e: Episode) => e.tokens.filter(t => /\|(content.display|field.edit|control.activate|form.submit_attempt)\|/.test(t));
  return similarity(important(a), important(b)) * 0.45 + semantic * 0.55;
}
/** Local similarity used to shortlist candidate patterns for Jev. Not a decision on its own. */
export function localScore(episode: Episode, representative: Episode): number {
  const enriched = eligibility({ ...episode, closed: true }).content && eligibility({ ...representative, closed: true }).content;
  return enriched ? contentMatch(episode, representative) : similarity(episode.tokens, representative.tokens);
}
/** Each distinct completed episode is assigned once. Navigation alone never forms a workflow. */
export function groupEpisode(episode: Episode, workflows: Workflow[], episodes: Episode[]): Workflow | null {
  if (!meaningful(episode)) return null;
  const byId = new Map(episodes.map(e => [e.id, e]));
  const enriched = eligibility({ ...episode, closed: true }).content;
  let best: Workflow | undefined; let score = enriched ? LIMITS.contentSimilarity : LIMITS.similarity;
  for (const workflow of workflows) {
    if (workflow.excludedIds.includes(episode.id) || workflow.occurrenceIds.includes(episode.id)) continue;
    const rep = byId.get(workflow.representativeId); if (!rep) continue;
    if (eligibility({ ...rep, closed: true }).content !== enriched) continue;
    const s = enriched ? contentMatch(episode, rep) : similarity(episode.tokens, rep.tokens);
    const overlap = new Set(episode.tokens.filter(t => t.includes('|control.activate|') && !t.endsWith('|unknown') && rep.tokens.includes(t))).size;
    const submits = episode.tokens.some(t => t.includes('|form.submit_attempt|') && rep.tokens.includes(t));
    if (s >= score && (enriched || overlap >= 2 || overlap >= 1 && submits || submits && episode.tokens.filter(t => t.includes('|form.submit_attempt|')).length >= 2)) { best = workflow; score = s; }
  }
  if (best) return { ...best, occurrenceIds: [...best.occurrenceIds, episode.id], score, matchedBy: 'local' };
  return { id: crypto.randomUUID(), representativeId: episode.id, occurrenceIds: [episode.id], excludedIds: [], score: 1, feedbackVersion: 0, dismissedAtCount: null, matchedBy: 'local' };
}
export function buildSummary(workflow: Workflow, episodes: Episode[], feedback: Feedback[], sites: { id: string; alias: string }[], contexts: ContentRecord[] = []): WorkflowSummary {
  const occurrences = episodes.filter(e => workflow.occurrenceIds.includes(e.id)).sort((a, b) => a.start - b.start);
  if (!occurrences.length) throw new Error('No surviving evidence');
  const refs = new Set(occurrences.flatMap(e => e.tokens.map(t => t.split('|')[0])));
  const latestIntent = feedback.filter(f => f.workflowId === workflow.id && f.type === 'intent').sort((a, b) => b.version - a.version)[0];
  const superseded = new Set(feedback.filter(f => f.workflowId === workflow.id).map(f => f.supersedes).filter(Boolean));
  const rules = feedback.filter(f => f.workflowId === workflow.id && f.type === 'rule' && !superseded.has(f.id));
  const sampled = occurrences.slice(-20);
  const summary = SummarySchema.parse({
    schemaVersion: '2.0', workflowId: workflow.id,
    apps: [...refs].map(ref => ({ ref, alias: sites.find(s => s.id === ref)?.alias ?? 'Removed app' })),
    occurrences: sampled.map(e => {
      const evidence = contexts.filter(c => c.episodeId === e.id);
      // Latest display plus up to three settled edits; bounded, explicit privacy preview.
      const selected = [...evidence.filter(c => c.kind === 'content.display').slice(-1), ...evidence.filter(c => c.kind === 'field.edit').slice(-3)].sort((a, b) => a.time - b.time);
      return { ref: e.id, actions: e.tokens.map(t => { const [app, category, action] = t.split('|'); return { app, category, action }; }), approximateActiveMs: e.activeMs,
        content: selected.map(c => ({ ref: c.id, kind: c.kind, label: c.label, text: c.text.slice(0, 900), before: c.before === null ? null : c.before.slice(0, 600), after: c.after.slice(0, 600), fieldType: c.fieldType, truncated: c.truncated || c.text.length > 900 || (c.before?.length ?? 0) > 600 || c.after.length > 600 })),
      };
    }),
    occurrenceCount: occurrences.length,
    approximateMeanActiveMs: Math.round(occurrences.reduce((n, e) => n + e.activeMs, 0) / occurrences.length),
    observedSpanDays: Math.round((Math.max(...occurrences.map(e => e.end)) - Math.min(...occurrences.map(e => e.start))) / 86400000 * 100) / 100,
    feedbackVersion: workflow.feedbackVersion,
    confirmed: [...(latestIntent ? [latestIntent] : []), ...rules].map(f => ({ ref: f.id, type: f.type, text: f.text })),
    limitations: [
      'A displayed excerpt does not prove it was read. Settled text edits do not prove business intent, copying, submission success, or authorization to execute.',
      'Page content and edits are bounded and redacted best-effort. Redaction is incomplete; review every outbound string. No screenshots, clipboard, keystroke logs, source URLs or selectors.',
      'Only visible top-level DOM text and supported non-protected fields. No iframes, closed shadow roots, canvas, native apps, privileged pages, or incognito.',
      'Approximate focused active time uses capped 30-second event intervals. Similarity is lexical/sequence-based, not semantic certainty or calibrated probability.',
      'At most the latest display excerpt and three edits per submitted occurrence are included. No complete reading/typing history or weekly frequency is established.',
      'Content evidence expires after 24 hours; dependent patterns, interpretations, and drafts are invalidated. Fields may be truncated.',
      ...(occurrences.some(e => e.gaps.length) ? ['Some episodes have known capture gaps; additional losses may be undetectable.'] : []),
    ],
  });
  // Prefer fewer whole occurrences to a huge request or silently dropping business rules.
  while (new TextEncoder().encode(JSON.stringify(summary)).length > 39000 && summary.occurrences.length > 1) summary.occurrences.shift();
  if (summary.occurrences.length < occurrences.length) summary.limitations.push(`Only ${summary.occurrences.length} recent occurrences are shared; total count and timing are computed from all surviving evidence.`);
  return SummarySchema.parse(summary);
}
