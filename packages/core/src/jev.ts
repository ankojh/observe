import { z } from 'zod';
import { Action, PageType, type ContentRecord, type Episode, type ObservedEvent } from './schemas';

/** Thresholds the extension applies to Jev's calibrated probabilities. */
export const JEV_THRESHOLDS = {
  action: 0.5, relevant: 0.3, sensitive: 0.5, match: 0.5, sensitiveSite: 0.5,
  suggestFinished: 0.6, autoClose: 0.8, // Boundary: show a suggestion, or close the episode automatically.
  work: 0.5, routine: 0.5, // Triage: both must pass for a single episode to be saved as a candidate.
};
export const JEV_LIMITS = { timeoutMs: 4000, candidates: 8, briefActions: 40, briefDisplays: 3, briefEdits: 3, displayChars: 400, editChars: 200, hintChars: 120 };

const short = (n: number) => z.string().max(n);
/** Compact, already-redacted description of one episode. Never contains full URLs, selectors, or raw events. */
export const EpisodeBrief = z.object({
  apps: z.array(short(80)).max(20),
  actions: z.array(short(240)).max(JEV_LIMITS.briefActions),
  content: z.array(z.object({ kind: z.enum(['content.display', 'field.edit']), label: short(80), text: short(JEV_LIMITS.displayChars) }).strict()).max(JEV_LIMITS.briefDisplays + JEV_LIMITS.briefEdits),
  activeMinutes: z.number().nonnegative().max(1440),
}).strict();
export type EpisodeBrief = z.infer<typeof EpisodeBrief>;

const recent = z.array(short(240)).max(12);
export const JevRequest = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('action'), control: z.object({ role: z.enum(['button', 'link']), label: short(JEV_LIMITS.hintChars).min(1) }).strict(), recent }).strict(),
  z.object({
    kind: z.literal('relevance'), recent, outcomeCheck: z.boolean(),
    content: z.object({ kind: z.enum(['content.display', 'field.edit']), label: short(80), text: short(3000), before: short(1200).nullable(), after: short(1200) }).strict(),
  }).strict(),
  z.object({ kind: z.literal('site'), hostname: short(253).min(1), title: short(120) }).strict(),
  z.object({ kind: z.literal('boundary'), episode: EpisodeBrief }).strict(),
  z.object({ kind: z.literal('triage'), episode: EpisodeBrief }).strict(),
  z.object({ kind: z.literal('match'), episode: EpisodeBrief, candidates: z.array(z.object({ id: z.string().uuid(), purpose: short(1200).nullable(), brief: EpisodeBrief }).strict()).min(1).max(JEV_LIMITS.candidates) }).strict(),
]);
export type JevRequest = z.infer<typeof JevRequest>;

const p = z.number().min(0).max(1);
const model = z.string().max(100);
export const SiteCategory = z.enum(['work_tool', 'email', 'shopping', 'news_media', 'social', 'banking_finance', 'healthcare', 'government', 'password_or_identity', 'hr_payroll', 'adult', 'other']);
export type SiteCategory = z.infer<typeof SiteCategory>;
export const SENSITIVE_SITE_CATEGORIES: SiteCategory[] = ['banking_finance', 'healthcare', 'government', 'password_or_identity', 'hr_payroll', 'adult'];
export const JevDecision = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('action'), action: Action, probability: p, model }).strict(),
  z.object({ kind: z.literal('relevance'), relevant: p, sensitive: p, pageType: PageType, succeeded: p.nullable(), model }).strict(),
  z.object({ kind: z.literal('site'), category: SiteCategory, sensitive: p, model }).strict(),
  z.object({ kind: z.literal('boundary'), finished: p, model }).strict(),
  z.object({ kind: z.literal('triage'), work: p, routine: p, automatable: p, model }).strict(),
  z.object({ kind: z.literal('match'), candidateId: z.string().uuid().nullable(), probability: p, model }).strict(),
]);
export type JevDecision = z.infer<typeof JevDecision>;

export function describeToken(t: string, alias: (id: string) => string, event?: Pick<ObservedEvent, 'target' | 'route'>): string {
  const [app, category, action] = t.split('|');
  return `${alias(app)}: ${category}${action !== 'unknown' ? ` → ${action}` : ''}${event?.target ? ` [${event.target}]` : ''}${event?.route ? ` @ ${event.route}` : ''}`;
}
/** One line per event with element names and routes; collapses consecutive duplicates. Falls back to tokens when events are unavailable. */
export function describeEpisode(episode: Episode, events: ObservedEvent[], alias: (id: string) => string): string[] {
  const byId = new Map(events.map(e => [e.id, e]));
  const own = episode.eventIds.map(id => byId.get(id)).filter((e): e is ObservedEvent => !!e && e.category !== 'page.visibility_change');
  if (!own.length) return episode.tokens.map(t => describeToken(t, alias));
  const lines: string[] = [];
  for (const e of own) {
    const line = describeToken(`${e.siteId}|${e.category}|${e.action}`, alias, { target: e.target, route: e.route });
    if (lines[lines.length - 1] !== line) lines.push(line);
  }
  return lines;
}
/** Bounded episode description from stored, already-redacted evidence. Events add clicked elements and routes. */
export function episodeBrief(episode: Episode, contexts: ContentRecord[], alias: (id: string) => string, events: ObservedEvent[] = []): EpisodeBrief {
  const own = contexts.filter(c => c.episodeId === episode.id).sort((a, b) => a.time - b.time);
  const displays = own.filter(c => c.kind === 'content.display').slice(-JEV_LIMITS.briefDisplays).map(c => ({ kind: c.kind, label: c.pageType ? `${c.label} (${c.pageType})` : c.label, text: c.text.slice(0, JEV_LIMITS.displayChars) }));
  const edits = own.filter(c => c.kind === 'field.edit').slice(-JEV_LIMITS.briefEdits).map(c => ({ kind: c.kind, label: c.label, text: c.after.slice(0, JEV_LIMITS.editChars) }));
  return EpisodeBrief.parse({
    apps: [...new Set(episode.tokens.map(t => alias(t.split('|')[0])))].slice(0, 20),
    actions: describeEpisode(episode, events, alias).map(l => l.slice(0, 240)).slice(-JEV_LIMITS.briefActions),
    content: [...displays, ...edits].map(c => ({ ...c, label: c.label.slice(0, 80) })),
    activeMinutes: Math.round(episode.activeMs / 600) / 100,
  });
}
