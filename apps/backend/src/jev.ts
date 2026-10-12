import { z } from 'zod';
import { Action } from '../../../packages/core/src/schemas';
import { JevDecision, type JevRequest } from '../../../packages/core/src/jev';

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
type Question =
  | { type: 'noul'; instructions: unknown; criteria?: { true?: unknown; false?: unknown } }
  | { type: 'choice'; instructions: unknown; criteria: Record<string, unknown> }
  | { type: 'score'; instructions: unknown; criteria: unknown[] };
const NoulAnswer = z.object({ type: z.literal('noul'), noul: z.number().min(0).max(1) }).passthrough();
const ChoiceAnswer = z.object({ type: z.literal('choice'), choice: z.string(), probabilities: z.record(z.number()), confidence: z.number() }).passthrough();
const Response = z.object({
  model: z.string().max(100),
  answers: z.record(z.union([NoulAnswer, ChoiceAnswer, z.object({ type: z.literal('score') }).passthrough()])),
  usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative().optional() }).passthrough(),
}).passthrough();

const ACTION_CRITERIA: Record<z.infer<typeof Action>, string> = {
  open: 'Opens or views an item, record, page, or details',
  search: 'Runs a search or applies a filter',
  save: 'Saves, updates, submits, or confirms changes',
  edit: 'Enters an edit mode for an existing item',
  next: 'Moves to the next step or page of a multi-step flow',
  back: 'Returns to the previous step or page',
  reply: 'Replies to a message, comment, or thread',
  send: 'Sends a message, email, invitation, or request to someone',
  cancel: 'Cancels or discards the current operation',
  delete: 'Deletes, removes, or archives an item',
  add: 'Creates or adds a new item',
  close: 'Closes a dialog, panel, tab, or item',
  unknown: 'None of the above, or the label does not make the action clear',
};

/** Fixed question templates. The extension sends only typed state; it cannot author questions. */
export function questionsFor(req: JevRequest): { state: unknown; questions: Record<string, Question> } {
  switch (req.kind) {
    case 'action': return {
      state: { control: req.control, recentActivity: req.recent },
      questions: { action: { type: 'choice', instructions: 'A user activated `control` in a web application. Which action does it most likely perform? Judge from the control\'s own label and role; `recentActivity` is supporting context only.', criteria: ACTION_CRITERIA } },
    };
    case 'relevance': return {
      state: { content: req.content, recentActivity: req.recent },
      questions: {
        relevant: { type: 'noul', instructions: 'Is `content` part of the work the user is doing, such as the record, message, form, or data they are reading or editing?', criteria: { true: 'Task material the user is working with', false: 'Site navigation, menus, ads, cookie or consent banners, footers, or other boilerplate' } },
        sensitive: { type: 'noul', instructions: 'Does `content` contain passwords, secrets, access tokens, government ID numbers, full payment card or bank account numbers, or medical information about a person?' },
      },
    };
    case 'boundary': return {
      state: req.episode,
      questions: { finished: { type: 'noul', instructions: 'Based on `actions` and `content`, has the user just completed a self-contained task, such as submitting, sending, or saving the item they were working on?', criteria: { true: 'The task looks finished', false: 'The user still appears to be in the middle of the task' } } },
    };
    case 'match': {
      const criteria: Record<string, unknown> = {};
      req.candidates.forEach((c, i) => { criteria[`pattern_${i + 1}`] = { confirmedPurpose: c.purpose ?? 'unknown', example: c.brief }; });
      criteria.new_task = 'A different task from every listed pattern';
      return {
        state: { newEpisode: req.episode },
        questions: { match: { type: 'choice', instructions: 'Which listed pattern is the same recurring task as `newEpisode`? The same task means the same kind of work toward the same goal, even if specific records, values, wording, or step order differ. Choose new_task if none is the same task.', criteria } },
      };
    }
  }
}

export function decode(req: JevRequest, model: string, answers: Record<string, unknown>): JevDecision {
  switch (req.kind) {
    case 'action': {
      const a = ChoiceAnswer.parse(answers.action); const action = Action.parse(a.choice);
      return JevDecision.parse({ kind: 'action', action, probability: a.probabilities[a.choice] ?? 0, model });
    }
    case 'relevance': return JevDecision.parse({ kind: 'relevance', relevant: NoulAnswer.parse(answers.relevant).noul, sensitive: NoulAnswer.parse(answers.sensitive).noul, model });
    case 'boundary': return JevDecision.parse({ kind: 'boundary', finished: NoulAnswer.parse(answers.finished).noul, model });
    case 'match': {
      const a = ChoiceAnswer.parse(answers.match); const index = /^pattern_(\d+)$/.exec(a.choice);
      const candidate = index ? req.candidates[Number(index[1]) - 1] : undefined;
      return JevDecision.parse({ kind: 'match', candidateId: candidate?.id ?? null, probability: a.probabilities[a.choice] ?? 0, model });
    }
  }
}

export class JevClient {
  constructor(private config: { apiKey: string; model: string }) {}
  /** One retry on 429/529, honouring a short Retry-After. Jev bills input tokens only. */
  async ask(req: JevRequest, signal: AbortSignal): Promise<{ decision: JevDecision; inputTokens: number }> {
    const { state, questions } = questionsFor(req);
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(ENDPOINT, {
        method: 'POST', signal,
        headers: { Authorization: `Bearer ${this.config.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.config.model, state, questions }),
      });
      if ((response.status === 429 || response.status === 529) && attempt === 0) {
        const wait = Math.min(2000, Math.max(200, Number(response.headers.get('retry-after') ?? 0.5) * 1000));
        await new Promise(r => setTimeout(r, wait)); continue;
      }
      // Never log upstream bodies; they may echo submitted state.
      if (response.status === 401) throw new Error('Jev authentication failed. Check TYPESAFE_API_KEY.');
      if (response.status === 422) throw new Error('Jev rejected the request shape (422).');
      if (response.status === 429 || response.status === 529) throw new Error('Jev rate limited or overloaded.');
      if (!response.ok) throw new Error(`Jev request failed (${response.status}).`);
      const raw = await response.text();
      if (raw.length > 64_000) throw new Error('Jev response exceeded limit');
      const data = Response.parse(JSON.parse(raw));
      return { decision: decode(req, data.model, data.answers), inputTokens: data.usage.input_tokens };
    }
  }
}
