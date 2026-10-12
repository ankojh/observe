import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { DefinitionInput, JobRequest, WorkflowSummary } from '../../../packages/core/src/schemas';
import { JevRequest, JEV_LIMITS } from '../../../packages/core/src/jev';
import { OpenAIInterpreter, SYSTEM } from './provider';
import { JevClient } from './jev';

const dir = fileURLToPath(new URL('../data/', import.meta.url));
mkdirSync(dir, { recursive: true, mode: 0o700 });
chmodSync(dir, 0o700);
const tokenFile = `${dir}pairing-token.txt`;
if (!existsSync(tokenFile)) writeFileSync(tokenFile, randomBytes(32).toString('hex'), { mode: 0o600 });
const token = readFileSync(tokenFile, 'utf8').trim();
const allowedOrigin = process.env.OBSERVE_EXTENSION_ORIGIN;
if (!allowedOrigin || !/^chrome-extension:\/\/[a-p]{32}$/.test(allowedOrigin)) {
  console.error('Set OBSERVE_EXTENSION_ORIGIN=chrome-extension://<ID from chrome://extensions> in apps/backend/.env.'); process.exit(1);
}
const price = (key: string) => {
  const n = Number(process.env[key]); return Number.isFinite(n) && n > 0 ? n : null;
};
const model = process.env.OPENAI_MODEL;
const apiKey = process.env.OPENAI_API_KEY;
const requestCap = price('MAX_REQUEST_USD');
const dayCap = price('MAX_DAILY_USD');
const inputRate = price('INPUT_USD_PER_MILLION_TOKENS');
const outputRate = price('OUTPUT_USD_PER_MILLION_TOKENS');
const maxOutputTokens = Number(process.env.MAX_OUTPUT_TOKENS ?? 2500);
const configured = !!(model && apiKey && requestCap && dayCap && inputRate && outputRate && process.env.PROVIDER_TERMS_ACKNOWLEDGED === 'true' && Number.isInteger(maxOutputTokens) && maxOutputTokens >= 512 && maxOutputTokens <= 4096);
const provider = configured ? new OpenAIInterpreter({ model: model!, apiKey: apiKey!, maxOutputTokens }) : null;
const jevModel = process.env.JEV_MODEL || 'jev-latest';
const jevDailyTokens = Number(process.env.JEV_MAX_DAILY_TOKENS);
const jevConfigured = !!process.env.TYPESAFE_API_KEY && Number.isInteger(jevDailyTokens) && jevDailyTokens > 0;
const jev = jevConfigured ? new JevClient({ apiKey: process.env.TYPESAFE_API_KEY!, model: jevModel }) : null;
const db = new DatabaseSync(`${dir}jobs.sqlite`);
chmodSync(`${dir}jobs.sqlite`, 0o600);
db.exec(`PRAGMA journal_mode=WAL;
 CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, hash TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL, created INTEGER NOT NULL, result TEXT, error TEXT);
 CREATE TABLE IF NOT EXISTS budgets (day TEXT PRIMARY KEY, reserved REAL NOT NULL);
 CREATE TABLE IF NOT EXISTS jev_usage (day TEXT PRIMARY KEY, tokens INTEGER NOT NULL);`);
db.prepare("UPDATE jobs SET state='failed', result=NULL, error='Server restarted; request interrupted. Approve a fresh request.' WHERE state IN ('pending','running')").run();
type Row = { id: string; hash: string; kind: string; state: string; created: number; result: string | null; error: string | null };
const get = (id: string) => db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as Row | undefined;
const controllers = new Map<string, AbortController>();
const queue: { id: string; kind: 'analysis' | 'definition'; payload: unknown }[] = [];
let active = 0;
const cleanup = () => {
  db.prepare("DELETE FROM jobs WHERE created < ? AND state NOT IN ('pending','running')").run(Date.now() - 24 * 3600000);
  db.prepare('DELETE FROM budgets WHERE day < ?').run(new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10));
  db.prepare('DELETE FROM jev_usage WHERE day < ?').run(new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10));
};
cleanup(); setInterval(cleanup, 3600000).unref();
function pump() {
  while (active < 2 && queue.length) {
    const task = queue.shift()!;
    if (get(task.id)?.state !== 'pending') continue;
    active++; db.prepare("UPDATE jobs SET state='running' WHERE id=?").run(task.id);
    const controller = new AbortController(); controllers.set(task.id, controller);
    const timeout = setTimeout(() => controller.abort(), 60000);
    const promise = task.kind === 'analysis'
      ? provider!.interpret(WorkflowSummary.parse(task.payload), controller.signal)
      : provider!.draftDefinition(DefinitionInput.parse(task.payload), controller.signal);
    void promise.then(result => {
      if (get(task.id)?.state === 'running') db.prepare("UPDATE jobs SET state='succeeded', result=? WHERE id=?").run(JSON.stringify(result), task.id);
    }, error => {
      // Validation errors can include sensitive excerpts, so only publish known safe operational messages.
      const detail = error instanceof z.ZodError || error instanceof SyntaxError ? 'Provider returned invalid structured data.'
        : controller.signal.aborted ? 'Request cancelled or timed out. Charged work is not automatically retried.'
        : error instanceof Error && /^(OpenAI |Provider |AI result|User-confirmed|Unconfirmed|Draft references)/.test(error.message) ? error.message.slice(0, 240)
        : 'Provider request failed or returned unsupported evidence.';
      if (get(task.id)?.state === 'running') db.prepare("UPDATE jobs SET state='failed', result=NULL, error=? WHERE id=?").run(detail, task.id);
    }).finally(() => { clearTimeout(timeout); controllers.delete(task.id); active--; pump(); });
  }
}
const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.headers.host !== '127.0.0.1:4317') { res.status(403).json({ error: 'Invalid Host' }); return; }
  const origin = req.headers.origin;
  if (origin && origin !== allowedOrigin) { res.status(403).json({ error: 'Origin not authorized' }); return; }
  if (origin === allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  }
  if (req.method === 'OPTIONS') {
    if (origin !== allowedOrigin) res.sendStatus(403); else res.sendStatus(204);
    return;
  }
  const auth = req.headers.authorization;
  const supplied = Buffer.from(auth?.startsWith('Bearer ') ? auth.slice(7) : ''); const expected = Buffer.from(token);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { res.status(401).json({ error: 'Pairing authentication required' }); return; }
  next();
});
app.use(express.json({ limit: '48kb', strict: true }));
app.get('/health', (_req, res) => res.json({ ok: true, provider: 'OpenAI', configured, model: model ?? null, retentionHours: 24, mockProvider: false, jev: { configured: jevConfigured, model: jevConfigured ? jevModel : null }, note: 'No mock provider. Model, costs, and account terms must be configured before any call.' }));
let jevRequests: number[] = [];
// Synchronous Jev decisions for live capture. State is transient: nothing about the request is persisted except daily token usage.
app.post('/jev', async (req, res) => {
  if (!jev) { res.status(503).json({ error: 'Jev disabled: set TYPESAFE_API_KEY and JEV_MAX_DAILY_TOKENS on the backend.' }); return; }
  const parsed = JevRequest.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid Jev request' }); return; }
  jevRequests = jevRequests.filter(t => t > Date.now() - 60000);
  if (jevRequests.length >= 240) { res.status(429).json({ error: 'Local Jev request limit reached.' }); return; }
  const day = new Date().toISOString().slice(0, 10);
  const used = (db.prepare('SELECT tokens FROM jev_usage WHERE day=?').get(day) as { tokens: number } | undefined)?.tokens ?? 0;
  if (used >= jevDailyTokens) { res.status(429).json({ error: 'Configured daily Jev token limit reached.' }); return; }
  jevRequests.push(Date.now());
  try {
    const { decision, inputTokens } = await jev.ask(parsed.data, AbortSignal.timeout(JEV_LIMITS.timeoutMs - 500));
    db.prepare('INSERT INTO jev_usage(day,tokens) VALUES (?,?) ON CONFLICT(day) DO UPDATE SET tokens=tokens+excluded.tokens').run(day, inputTokens);
    res.json(decision);
  } catch (error) {
    const detail = error instanceof Error && /^Jev /.test(error.message) ? error.message.slice(0, 200) : error instanceof DOMException ? 'Jev request timed out.' : 'Jev returned an unexpected response.';
    res.status(502).json({ error: detail });
  }
});
let requests: number[] = [];
app.post(['/analysis-jobs', '/definition-jobs'], (req, res) => {
  const parsed = JobRequest.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid approved payload schema' }); return; }
  const body = parsed.data; const kind = req.path === '/analysis-jobs' ? 'analysis' : 'definition';
  if (body.kind !== kind) { res.status(400).json({ error: 'Job kind mismatch' }); return; }
  const payload = (kind === 'analysis' ? WorkflowSummary : DefinitionInput).safeParse(body.payload);
  if (!payload.success) { res.status(400).json({ error: 'Invalid summary or definition input' }); return; }
  const summary = 'summary' in payload.data ? payload.data.summary : payload.data;
  const refs = new Set(summary.occurrences.map(o => o.ref));
  if (refs.size !== summary.occurrences.length || summary.occurrenceCount < summary.occurrences.length || summary.occurrences.some(o => o.actions.some(a => !summary.apps.some(app => app.ref === a.app)))) {
    res.status(400).json({ error: 'Invalid or insufficient occurrence evidence' }); return;
  }
  const digest = createHash('sha256').update(JSON.stringify({ kind, payload: payload.data })).digest('hex');
  const existing = get(body.requestId);
  if (existing) {
    if (existing.hash !== digest) res.status(409).json({ error: 'Idempotency ID already used for a different payload' });
    else res.status(200).json({ id: existing.id, state: existing.state });
    return;
  }
  if (!provider) { res.status(503).json({ error: 'Live AI disabled: configure OpenAI model, credentials, spending caps/prices, and acknowledge account terms on the backend.' }); return; }
  requests = requests.filter(t => t > Date.now() - 60000);
  if (requests.length >= 6 || active + queue.length >= 6) { res.status(429).json({ error: 'Local request/concurrency limit reached. Try later.' }); return; }
  // Reserve a deliberately conservative upper-bound estimate; do not refund after uncertain failures.
  // UTF-8 bytes overestimate normal tokenizer input tokens; output includes reasoning tokens up to the configured limit.
  const maxInput = Buffer.byteLength(JSON.stringify(payload.data)) + Buffer.byteLength(SYSTEM) + 16000;
  const reservation = (maxInput * inputRate! + maxOutputTokens * outputRate!) / 1_000_000;
  const day = new Date().toISOString().slice(0, 10);
  const prior = (db.prepare('SELECT reserved FROM budgets WHERE day=?').get(day) as { reserved: number } | undefined)?.reserved ?? 0;
  if (reservation > requestCap! || prior + reservation > dayCap!) { res.status(429).json({ error: 'Configured estimated cost limit reached; no provider call was made.' }); return; }
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT INTO budgets(day,reserved) VALUES (?,?) ON CONFLICT(day) DO UPDATE SET reserved=reserved+excluded.reserved').run(day, reservation);
    db.prepare("INSERT INTO jobs(id,hash,kind,state,created) VALUES (?,?,?,'pending',?)").run(body.requestId, digest, kind, Date.now());
    db.exec('COMMIT');
  } catch { db.exec('ROLLBACK'); res.status(500).json({ error: 'Could not persist job; no provider call made.' }); return; }
  requests.push(Date.now()); queue.push({ id: body.requestId, kind, payload: payload.data });
  res.status(202).json({ id: body.requestId, state: 'pending' }); pump();
});
app.get('/jobs/:id', (req, res) => {
  const job = get(req.params.id); if (!job) { res.status(404).json({ error: 'Job expired or does not exist. Reapprove if needed.' }); return; }
  res.json({ id: job.id, state: job.state, error: job.error, result: job.result ? JSON.parse(job.result) : null });
});
app.delete('/jobs/:id', (req, res) => {
  const job = get(req.params.id);
  if (job) {
    db.prepare("UPDATE jobs SET state='failed', result=NULL, error='Cancelled and local result erased' WHERE id=?").run(job.id);
    controllers.get(job.id)?.abort();
  }
  res.json({ ok: true, note: 'Provider retention cannot be recalled. Input is no longer retained after queued/in-flight work ends.' });
});
app.use((_req, res) => { res.status(404).json({ error: 'Unknown endpoint' }); });
app.use((error: { type?: string; status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(error.status === 413 ? 413 : 400).json({ error: error.status === 413 ? 'Payload too large' : 'Invalid request' });
});
const server = app.listen(4317, '127.0.0.1', () => {
  console.log(`Observe backend: http://127.0.0.1:4317 (loopback only). Live AI ${configured ? 'configured' : 'DISABLED until configured'}. Jev ${jevConfigured ? `configured (${jevModel})` : 'DISABLED until configured'}.`);
  console.log(`Pairing token file: ${tokenFile} (copy into extension settings; never commit or share it).`);
});
server.requestTimeout = 15000; server.headersTimeout = 10000;
process.on('SIGINT', () => { for (const c of controllers.values()) c.abort(); server.close(() => process.exit(0)); });
