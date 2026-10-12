import { z } from 'zod';
import { Action, type ContentRecord, type Episode } from './schemas';

/** Thresholds the extension applies to Jev's calibrated probabilities. */
export const JEV_THRESHOLDS = { action: 0.5, relevant: 0.3, sensitive: 0.5, finished: 0.7, match: 0.5 };
export const JEV_LIMITS = { timeoutMs: 4000, candidates: 8, briefActions: 40, briefDisplays: 3, briefEdits: 3, displayChars: 400, editChars: 200, hintChars: 120 };

const short = (n: number) => z.string().max(n);
/** Compact, already-redacted description of one episode. Never contains URLs, selectors, or raw events. */
export const EpisodeBrief = z.object({
  apps: z.array(short(80)).max(20),
  actions: z.array(short(120)).max(JEV_LIMITS.briefActions),
  content: z.array(z.object({ kind: z.enum(['content.display', 'field.edit']), label: short(80), text: short(JEV_LIMITS.displayChars) }).strict()).max(JEV_LIMITS.briefDisplays + JEV_LIMITS.briefEdits),
  activeMinutes: z.number().nonnegative().max(1440),
}).strict();
export type EpisodeBrief = z.infer<typeof EpisodeBrief>;

export const JevRequest = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('action'), control: z.object({ role: z.enum(['button', 'link']), label: short(JEV_LIMITS.hintChars).min(1) }).strict(), recent: z.array(short(120)).max(12) }).strict(),
  z.object({
    kind: z.literal('relevance'), recent: z.array(short(120)).max(12),
    content: z.object({ kind: z.enum(['content.display', 'field.edit']), label: short(80), text: short(3000), before: short(1200).nullable(), after: short(1200) }).strict(),
  }).strict(),
  z.object({ kind: z.literal('boundary'), episode: EpisodeBrief }).strict(),
  z.object({ kind: z.literal('match'), episode: EpisodeBrief, candidates: z.array(z.object({ id: z.string().uuid(), purpose: short(1200).nullable(), brief: EpisodeBrief }).strict()).min(1).max(JEV_LIMITS.candidates) }).strict(),
]);
export type JevRequest = z.infer<typeof JevRequest>;

const p = z.number().min(0).max(1);
const model = z.string().max(100);
export const JevDecision = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('action'), action: Action, probability: p, model }).strict(),
  z.object({ kind: z.literal('relevance'), relevant: p, sensitive: p, model }).strict(),
  z.object({ kind: z.literal('boundary'), finished: p, model }).strict(),
  z.object({ kind: z.literal('match'), candidateId: z.string().uuid().nullable(), probability: p, model }).strict(),
]);
export type JevDecision = z.infer<typeof JevDecision>;

export function describeToken(t: string, alias: (id: string) => string): string {
  const [app, category, action] = t.split('|');
  return `${alias(app)}: ${category}${action !== 'unknown' ? ` → ${action}` : ''}`;
}
/** Bounded episode description from stored, already-redacted evidence. */
export function episodeBrief(episode: Episode, contexts: ContentRecord[], alias: (id: string) => string): EpisodeBrief {
  const own = contexts.filter(c => c.episodeId === episode.id).sort((a, b) => a.time - b.time);
  const displays = own.filter(c => c.kind === 'content.display').slice(-JEV_LIMITS.briefDisplays).map(c => ({ kind: c.kind, label: c.label, text: c.text.slice(0, JEV_LIMITS.displayChars) }));
  const edits = own.filter(c => c.kind === 'field.edit').slice(-JEV_LIMITS.briefEdits).map(c => ({ kind: c.kind, label: c.label, text: c.after.slice(0, JEV_LIMITS.editChars) }));
  return EpisodeBrief.parse({
    apps: [...new Set(episode.tokens.map(t => alias(t.split('|')[0])))].slice(0, 20),
    actions: episode.tokens.slice(-JEV_LIMITS.briefActions).map(t => describeToken(t, alias)),
    content: [...displays, ...edits],
    activeMinutes: Math.round(episode.activeMs / 600) / 100,
  });
}
