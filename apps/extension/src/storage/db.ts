import Dexie, { type Table } from 'dexie';
import type { AgentDefinition, ContentRecord, DefinitionInput, Episode, Feedback, ObservedEvent, Workflow, WorkflowSummary } from '../../../../packages/core/src/schemas';
export type SiteVerdict = { sensitive: boolean; category: string; probability: number; by: 'local' | 'jev'; time: number };
export type Site = { id: string; origin: string; pattern: string; alias: string; auto?: boolean; blocked?: boolean; verdict?: SiteVerdict };
/**
 * allSites: one broad grant; sites are discovered on first visit and screened before capture.
 * contentEnabled: always-on page text and field-edit capture; contentSessionId rotates on every epoch change.
 */
export type Consent = {
  id: 'state'; enabled: boolean; epoch: number; generation: number; sites: Site[]; retentionDays: number; error: string | null;
  allSites: boolean; contentEnabled: boolean; contentSessionId: string;
};
export type AIJob = {
  id: string; workflowId: string; generation: number; kind: 'analysis' | 'definition';
  payload: WorkflowSummary | DefinitionInput; hash: string; evidenceHash: string; time: number;
  state: 'approved' | 'pending' | 'running' | 'succeeded' | 'failed'; error?: string;
};
export class ObserveDB extends Dexie {
  events!: Table<ObservedEvent, string>; episodes!: Table<Episode, string>;
  workflows!: Table<Workflow, string>; feedback!: Table<Feedback, string>;
  definitions!: Table<AgentDefinition, string>; aiJobs!: Table<AIJob, string>;
  consents!: Table<Consent, string>; contexts!: Table<ContentRecord, string>;
  constructor() {
    super('observe');
    this.version(1).stores({
      events: 'id,time,siteId,tabId,[document+sequence]', episodes: 'id,start,end,closed',
      workflows: 'id,representativeId', feedback: 'id,workflowId,[workflowId+version]',
      definitions: 'id,provenance.workflowId', aiJobs: 'id,workflowId,state,time', consents: 'id',
    });
    this.version(2).stores({ contexts: 'id,time,episodeId,siteId', episodes: 'id,start,end' }).upgrade(async tx => {
      await tx.table('consents').toCollection().modify(c => { c.enabled = false; c.epoch++; c.generation++; c.contentSession = null; });
      await tx.table('aiJobs').toCollection().modify(j => { if (!['succeeded', 'failed'].includes(j.state)) { j.state = 'failed'; j.error = 'Extension upgraded; review and approve a new payload.'; } });
    });
    this.version(3).stores({}).upgrade(async tx => {
      await tx.table('consents').toCollection().modify(c => {
        delete c.contentSession; c.allSites = false; c.contentEnabled = true; c.contentSessionId = crypto.randomUUID(); c.epoch++;
      });
    });
  }
}
export const db = new ObserveDB();
export const initialConsent = (): Consent => ({ id: 'state', enabled: false, epoch: 0, generation: 0, sites: [], retentionDays: 7, error: null, allSites: false, contentEnabled: true, contentSessionId: crypto.randomUUID() });
export const state = async () => (await db.consents.get('state')) ?? initialConsent();
export async function hash(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}
