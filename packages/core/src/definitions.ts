import { AgentDefinition as Schema, type AgentDefinition, type DefinitionDraft, type WorkflowSummary } from './schemas';

export function makeDefinition(summary: WorkflowSummary, draft: DefinitionDraft | null, interpretationVersion = 0): AgentDefinition {
  const intent = summary.confirmed.find(c => c.type === 'intent')?.text;
  const base: DefinitionDraft = draft ?? {
    title: intent ?? 'Unresolved workflow draft', description: 'Manual definition based on minimized, local evidence. Business purpose needs user review.',
    goal: intent ?? 'Clarify the goal of this recurring sequence before proposing automation.',
    nonGoals: ['No execution, deployment, replay, or autonomous browser actions.'],
    inputs: [], steps: [{ id: 'review', instruction: 'Confirm intent, required inputs, and business rules with the user.', dependsOn: [], evidenceRefs: summary.occurrences.map(e => e.ref) }],
    capabilities: [], rules: [], outputs: ['A reviewed proposal; no changes to external systems.'],
    successCriteria: ['The user confirms intent, rules, and outputs.'], approvalRequirements: ['Human review of every proposed external change.'],
    prohibitedActions: ['Do not execute this definition.', 'Do not access credentials or perform irreversible actions.'],
    questions: ['What outcome is intended?', 'Which inputs and business rules are required?', 'What capabilities and approvals would deployment need?'],
  };
  const confirmedRules = summary.confirmed.filter(c => c.type === 'rule').map(c => ({ text: c.text, source: 'user-confirmed' as const }));
  return Schema.parse({
    ...base, ...(intent ? { goal: intent, title: intent } : {}),
    rules: [...base.rules.filter(r => r.source !== 'user-confirmed' && !confirmedRules.some(c => c.text === r.text)), ...confirmedRules],
    schemaVersion: '1.0', id: crypto.randomUUID(), version: 1, status: base.questions.length ? 'needs_clarification' : 'draft',
    provenance: {
      workflowId: summary.workflowId, occurrenceRefs: summary.occurrences.map(e => e.ref), occurrenceCount: summary.occurrenceCount,
      approximateMeanActiveMs: summary.approximateMeanActiveMs, interpretationVersion, feedbackVersion: summary.feedbackVersion,
      source: draft ? 'hosted-ai' : 'manual', evidenceScope: 'Opaque references resolve only in this installation. Not executable or deployed.',
    },
    savings: { remainingHumanReviewMs: summary.approximateMeanActiveMs, assumedSavingsPerOccurrenceMs: 0, note: 'No savings established. Remaining review time defaults to all observed active time; edit assumptions explicitly. No weekly projection.' },
  });
}
/** Escape model/user prose for portable Markdown; never export executable HTML. */
const md = (s: string) => s.replace(/[\\`*_{}\[\]()<>#!|]/g, '\\$&').replace(/\r?\n/g, '  \n');
export function markdown(value: AgentDefinition): string {
  const d = Schema.parse(value);
  const list = (items: string[]) => items.length ? items.map(t => `- ${md(t)}`).join('\n') : '- None specified (review required).';
  return `# ${md(d.title)}\n\n> NOT EXECUTABLE / NOT DEPLOYED. Status: ${d.status}. ${d.questions.length} unresolved questions.\n> Opaque evidence references resolve only in the originating installation. Exported files cannot be recalled by a local reset.\n\n${md(d.description)}\n\n## Goal\n${md(d.goal)}\n\n## Non-goals\n${list(d.nonGoals)}\n\n## Inputs\n${list(d.inputs.map(i => `${i.name} (${i.type}, ${i.required ? 'required' : 'optional'}): ${i.description}`))}\n\n## Steps\n${list(d.steps.map(s => `${s.id}: ${s.instruction}; depends on: ${s.dependsOn.join(', ') || 'none'}; evidence: ${s.evidenceRefs.join(', ') || 'unspecified'}`))}\n\n## Capabilities (all unverified)\n${list(d.capabilities.map(c => `${c.name} [${c.support}]: ${c.reason}`))}\n\n## Rules\n${list(d.rules.map(r => `[${r.source}] ${r.text}`))}\n\n## Outputs\n${list(d.outputs)}\n\n## Success criteria\n${list(d.successCriteria)}\n\n## Approval requirements\n${list(d.approvalRequirements)}\n\n## Prohibited actions\n${list(d.prohibitedActions)}\n\n## UNRESOLVED QUESTIONS\n${list(d.questions)}\n\n## Savings assumptions\n- Observed approximate mean active time: ${d.provenance.approximateMeanActiveMs} ms\n- Assumed remaining human review: ${d.savings.remainingHumanReviewMs} ms\n- Assumed savings per occurrence: ${d.savings.assumedSavingsPerOccurrenceMs} ms\n- ${md(d.savings.note)}\n\n## Versioned definition (same validated object as JSON export)\n\n\`\`\`json\n${JSON.stringify(d, null, 2).replace(/`/g, '\\u0060')}\n\`\`\`\n`;
}
