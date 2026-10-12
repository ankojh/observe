import { z } from 'zod';
import { Action, PageType } from '../../../packages/core/src/schemas';
import { JevDecision, SENSITIVE_SITE_CATEGORIES, SiteCategory, type JevRequest } from '../../../packages/core/src/jev';

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

const PAGE_CRITERIA: Record<z.infer<typeof PageType>, string> = {
  list_or_queue: 'A list, table, or queue of items to work through',
  record_detail: 'The details of one record, item, ticket, order, or invoice',
  form_or_editor: 'A form or editor for creating or changing something',
  search_results: 'Search or filter results',
  inbox_or_messages: 'An inbox, chat, or message thread',
  compose_message: 'Composing or replying to a message',
  dashboard: 'A dashboard or overview with summaries or charts',
  settings: 'Settings, preferences, or administration',
  document: 'An article, document, or long-form reading page',
  other: 'None of the above',
};
const SITE_CRITERIA: Record<SiteCategory, string> = {
  work_tool: 'Business software: CRM, ticketing, invoicing, project management, docs, spreadsheets, admin consoles',
  email: 'Webmail',
  shopping: 'Online shopping or marketplaces',
  news_media: 'News, blogs, video, or entertainment',
  social: 'Social networks or forums',
  banking_finance: 'Banking, payments, investing, crypto, tax, or personal finance accounts',
  healthcare: 'Healthcare providers, patient portals, insurance, or pharmacies',
  government: 'Government services',
  password_or_identity: 'Login, single sign-on, password managers, or identity verification',
  hr_payroll: 'HR, payroll, or benefits',
  adult: 'Adult content',
  other: 'Anything else',
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
        pageType: { type: 'choice', instructions: 'What kind of page or view does `content` come from?', criteria: PAGE_CRITERIA },
        ...(req.outcomeCheck ? { succeeded: { type: 'noul' as const, instructions: 'The user just submitted or saved something, and `content` is what the page showed next. Does it indicate success (a confirmation, a saved, sent, or updated state) rather than an error or validation problem?' } } : {}),
        relevant: { type: 'noul', instructions: 'Is `content` part of the work the user is doing, such as the record, message, form, or data they are reading or editing?', criteria: { true: 'Task material the user is working with', false: 'Site navigation, menus, ads, cookie or consent banners, footers, or other boilerplate' } },
        sensitive: { type: 'noul', instructions: 'Does `content` contain passwords, secrets, access tokens, government ID numbers, full payment card or bank account numbers, or medical information about a person?' },
      },
    };
    case 'site': return {
      state: { hostname: req.hostname, pageTitle: req.title },
      questions: { category: { type: 'choice', instructions: 'What kind of website is this, judging by its `hostname` and `pageTitle`?', criteria: SITE_CRITERIA } },
    };
    case 'triage': return {
      state: req.episode,
      questions: {
        work: { type: 'noul', instructions: 'Do `actions` and `content` show the user doing productive work, such as processing a record, communicating with someone, entering data, or researching for a task?', criteria: { true: 'Productive work', false: 'Casual browsing, reading for leisure, shopping, entertainment, or idle navigation' } },
        routine: { type: 'noul', instructions: 'Does this look like a routine procedure that someone would repeat many times with different records or data, rather than a one-off activity?' },
        automatable: { type: 'noul', instructions: 'Could a software agent plausibly carry out these steps, given the same inputs and access, with a human approving the result?' },
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
    case 'relevance': return JevDecision.parse({
      kind: 'relevance', relevant: NoulAnswer.parse(answers.relevant).noul, sensitive: NoulAnswer.parse(answers.sensitive).noul,
      pageType: PageType.parse(ChoiceAnswer.parse(answers.pageType).choice), succeeded: req.outcomeCheck ? NoulAnswer.parse(answers.succeeded).noul : null, model,
    });
    case 'site': {
      const a = ChoiceAnswer.parse(answers.category);
      const sensitive = Math.min(1, SENSITIVE_SITE_CATEGORIES.reduce((n, c) => n + (a.probabilities[c] ?? 0), 0));
      return JevDecision.parse({ kind: 'site', category: SiteCategory.parse(a.choice), sensitive, model });
    }
    case 'triage': return JevDecision.parse({ kind: 'triage', work: NoulAnswer.parse(answers.work).noul, routine: NoulAnswer.parse(answers.routine).noul, automatable: NoulAnswer.parse(answers.automatable).noul, model });
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
