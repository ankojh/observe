import { z } from 'zod';

const text = z.string().trim().min(1).max(1200);
const id = z.string().min(1).max(100);
export const Action = z.enum(['open', 'search', 'save', 'edit', 'next', 'back', 'reply', 'send', 'cancel', 'delete', 'add', 'close', 'unknown']);
export const BasicCategory = z.enum(['page.enter', 'page.route_change', 'control.activate', 'form.submit_attempt', 'page.visibility_change']);
export const Category = z.enum([...BasicCategory.options, 'content.display', 'field.edit']);
export const ContentData = z.object({
  kind: z.enum(['content.display', 'field.edit']), label: z.string().max(80),
  text: z.string().max(3000), before: z.string().max(1200).nullable(), after: z.string().max(1200),
  fieldType: z.enum(['none', 'text', 'search', 'number', 'textarea', 'contenteditable']),
  redactions: z.number().int().nonnegative().max(10000), truncated: z.boolean(),
}).strict().superRefine((c, ctx) => {
  if (c.kind === 'content.display' && (c.fieldType !== 'none' || c.before !== null || c.after !== '')) ctx.addIssue({ code: 'custom', message: 'Display evidence cannot contain field values' });
  if (c.kind === 'field.edit' && (c.fieldType === 'none' || c.text !== '')) ctx.addIssue({ code: 'custom', message: 'Edit evidence must describe a supported field' });
});
export type ContentData = z.infer<typeof ContentData>;
export const ContentPayload = z.object({
  id: z.string().uuid(), document: z.string().uuid(), sequence: z.number().int().nonnegative(),
  epoch: z.number().int().nonnegative(), visible: z.boolean(), sessionId: z.string().uuid(), data: ContentData,
}).strict();
export type ContentPayload = z.infer<typeof ContentPayload>;
export type ContentRecord = ContentData & { id: string; time: number; siteId: string; episodeId: string; document: string; sessionId: string };
export type ContentFeature = { app: string; kind: ContentData['kind']; label: string; terms: string[]; fieldType: ContentData['fieldType'] };
export const EventPayload = z.object({
  id: z.string().uuid(), document: z.string().uuid(), sequence: z.number().int().nonnegative(),
  epoch: z.number().int().nonnegative(), category: BasicCategory,
  action: Action, role: z.enum(['page', 'button', 'link', 'form', 'unknown']), visible: z.boolean(),
}).strict();
export type EventPayload = z.infer<typeof EventPayload>;
export type ObservedEvent = Omit<EventPayload, 'category'> & { category: z.infer<typeof Category>; time: number; siteId: string; tabId: number; contextRef?: string };
export type Episode = {
  id: string; eventIds: string[]; tokens: string[]; start: number; end: number;
  activeMs: number; closed: boolean; reason: string; gaps: string[]; timingBreak?: boolean; contentFeatures?: ContentFeature[];
};
export type Feedback = {
  id: string; workflowId: string; version: number; time: number;
  type: 'intent' | 'rule' | 'dismiss' | 'restore' | 'exclude'; text: string; episodeId?: string; supersedes?: string;
};
export type Workflow = {
  id: string; representativeId: string; occurrenceIds: string[]; excludedIds: string[];
  score: number; feedbackVersion: number; dismissedAtCount: number | null;
  interpretation?: { version: number; time: number; result: Interpretation; payloadHash: string; feedbackVersion: number; occurrenceCount: number };
  interpretationHistory?: Array<NonNullable<Workflow['interpretation']>>;
};
const claim = z.object({
  source: z.enum(['observed', 'inferred', 'user-confirmed']), statement: text,
  evidenceRefs: z.array(id).min(1).max(20), uncertainty: text,
}).strict();
export const Interpretation = z.object({
  name: text, purpose: text, claims: z.array(claim).min(1).max(20),
  alternatives: z.array(text).max(8), questions: z.array(text).min(1).max(20),
  automationBoundary: text, capabilities: z.array(text).max(20),
  feasibility: text, blockers: z.array(text).max(20),
}).strict();
export type Interpretation = z.infer<typeof Interpretation>;
export const ContentEvidence = z.object({
  ref: z.string().uuid(), kind: z.enum(['content.display', 'field.edit']), label: z.string().max(80),
  text: z.string().max(900), before: z.string().max(600).nullable(), after: z.string().max(600),
  fieldType: z.enum(['none', 'text', 'search', 'number', 'textarea', 'contenteditable']), truncated: z.boolean(),
}).strict();
export const WorkflowSummary = z.object({
  schemaVersion: z.enum(['1.0', '2.0']), workflowId: id,
  apps: z.array(z.object({ ref: id, alias: z.string().min(1).max(80) }).strict()).min(1).max(20),
  occurrences: z.array(z.object({
    ref: id, actions: z.array(z.object({ app: id, category: Category, action: Action }).strict()).min(1).max(120),
    approximateActiveMs: z.number().nonnegative().max(86400000),
    content: z.array(ContentEvidence).max(6).default([]),
  }).strict()).min(1).max(20),
  occurrenceCount: z.number().int().min(1).max(10000),
  approximateMeanActiveMs: z.number().nonnegative().max(86400000),
  observedSpanDays: z.number().nonnegative().max(3650),
  feedbackVersion: z.number().int().nonnegative(),
  confirmed: z.array(z.object({ ref: id, type: z.enum(['intent', 'rule']), text }).strict()).max(40),
  limitations: z.array(text).min(1).max(20),
}).strict();
export type WorkflowSummary = z.infer<typeof WorkflowSummary>;
export const DefinitionDraft = z.object({
  title: text, description: text, goal: text, nonGoals: z.array(text).min(1).max(20),
  inputs: z.array(z.object({ name: text, type: z.enum(['string', 'number', 'boolean', 'object', 'array']), required: z.boolean(), description: text }).strict()).max(30),
  steps: z.array(z.object({ id, instruction: text, dependsOn: z.array(id).max(30), evidenceRefs: z.array(id).max(20) }).strict()).min(1).max(30),
  capabilities: z.array(z.object({ name: text, support: z.literal('unverified'), reason: text }).strict()).max(30),
  rules: z.array(z.object({ text, source: z.enum(['user-confirmed', 'proposed']) }).strict()).max(40),
  outputs: z.array(text).min(1).max(20), successCriteria: z.array(text).min(1).max(20),
  approvalRequirements: z.array(text).min(1).max(20), prohibitedActions: z.array(text).min(1).max(20),
  questions: z.array(text).max(30),
}).strict();
export type DefinitionDraft = z.infer<typeof DefinitionDraft>;
export const AgentDefinition = DefinitionDraft.extend({
  schemaVersion: z.literal('1.0'), id, version: z.number().int().positive(),
  status: z.enum(['draft', 'needs_clarification', 'reviewed_definition']),
  provenance: z.object({
    workflowId: id, occurrenceRefs: z.array(id).max(10000), contentRefs: z.array(id).max(120).optional(), occurrenceCount: z.number().int().nonnegative(),
    approximateMeanActiveMs: z.number().nonnegative(), interpretationVersion: z.number().int().nonnegative(),
    feedbackVersion: z.number().int().nonnegative(), source: z.enum(['manual', 'hosted-ai']),
    evidenceScope: z.literal('Opaque references resolve only in this installation. Not executable or deployed.'),
  }).strict(),
  savings: z.object({ remainingHumanReviewMs: z.number().nonnegative(), assumedSavingsPerOccurrenceMs: z.number().nonnegative(), note: text }).strict(),
}).strict().superRefine((d, ctx) => {
  const stepIds = new Set(d.steps.map(s => s.id));
  if (stepIds.size !== d.steps.length) ctx.addIssue({ code: 'custom', message: 'Step IDs must be unique' });
  const seen = new Set<string>();
  for (const step of d.steps) {
    if (step.dependsOn.some(ref => !seen.has(ref))) ctx.addIssue({ code: 'custom', message: 'Dependencies must refer to earlier steps' });
    seen.add(step.id);
  }
  if (d.status === 'reviewed_definition' && d.questions.length) ctx.addIssue({ code: 'custom', message: 'Resolve questions before marking reviewed' });
});
export type AgentDefinition = z.infer<typeof AgentDefinition>;
export const DefinitionInput = z.object({ summary: WorkflowSummary, interpretation: Interpretation.nullable(), interpretationVersion: z.number().int().nonnegative() }).strict();
export type DefinitionInput = z.infer<typeof DefinitionInput>;
export const JobRequest = z.object({ requestId: z.string().uuid(), kind: z.enum(['analysis', 'definition']), payload: z.union([WorkflowSummary, DefinitionInput]), approval: z.literal(true) }).strict();

export function observedStatements(summary: WorkflowSummary): Set<string> {
  // An observed model claim must be one of these exact code-generated statements.
  // Anything richer belongs in inferred claims; no generic click proves a successful operation.
  return new Set(summary.occurrences.flatMap(o => [
    ...o.actions.map(a => `Recorded ${a.category} (${a.action}) in ${a.app}.`),
    ...o.content.map(c => c.kind === 'content.display' ? `Captured a displayed excerpt (${c.ref}); actual reading is unverified.` : `Captured an edit in an approved ${c.fieldType} field (${c.ref}); business success is unverified.`),
  ]));
}
export function validateGrounding(result: Interpretation, summary: WorkflowSummary) {
  const evidence = new Set([...summary.occurrences.map(e => e.ref), ...summary.occurrences.flatMap(e => e.content.map(c => c.ref)), ...summary.confirmed.map(f => f.ref)]);
  const confirmed = new Set(summary.confirmed.map(f => f.ref));
  for (const c of result.claims) {
    if (c.evidenceRefs.some(ref => !evidence.has(ref))) throw new Error('AI result references unsubmitted evidence');
    if (c.source === 'observed') {
      const cited = { ...summary, occurrences: summary.occurrences.filter(o => c.evidenceRefs.includes(o.ref) || o.content.some(v => c.evidenceRefs.includes(v.ref))).map(o => ({ ...o, content: o.content.filter(v => c.evidenceRefs.includes(v.ref) || c.evidenceRefs.includes(o.ref)) })) };
      if (!observedStatements(cited).has(c.statement)) throw new Error('AI result makes an unsupported observed claim');
    }
    if (c.source === 'user-confirmed' && (c.evidenceRefs.some(ref => !confirmed.has(ref)) || !summary.confirmed.some(f => c.evidenceRefs.includes(f.ref) && f.text === c.statement))) throw new Error('User-confirmed claim must quote a submitted correction exactly');
  }
}
export function validateDraftGrounding(draft: DefinitionDraft, summary: WorkflowSummary) {
  const evidence = new Set([...summary.occurrences.map(e => e.ref), ...summary.occurrences.flatMap(e => e.content.map(c => c.ref)), ...summary.confirmed.map(f => f.ref)]);
  if (draft.steps.some(s => s.evidenceRefs.some(ref => !evidence.has(ref)))) throw new Error('Draft references unsubmitted evidence');
  for (const rule of draft.rules) {
    if (rule.source === 'user-confirmed' && !summary.confirmed.some(c => c.type === 'rule' && c.text === rule.text)) throw new Error('Unconfirmed business rule');
  }
}
