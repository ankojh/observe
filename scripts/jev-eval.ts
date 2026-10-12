// Replays the synthetic fixtures against live Jev with the extension's thresholds. Run: npm run jev:eval
// Reads TYPESAFE_API_KEY from apps/backend/.env. Costs a few thousand input tokens per run.
import { JevClient } from '../apps/backend/src/jev';
import { JEV_THRESHOLDS, type JevDecision, type JevRequest } from '../packages/core/src/jev';
import { routeTemplate, valueSource } from '../packages/core/src/privacy';
import * as F from './jev-fixtures';

const results: { kind: string; name: string; pass: boolean; detail: string }[] = [];
const record = (kind: string, name: string, pass: boolean, detail: string) => results.push({ kind, name, pass, detail });
const pct = (n: number) => `${Math.round(n * 100)}%`;
const id = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

for (const [path, hash, expected] of F.routes) { const got = routeTemplate(path, hash); record('route', `${path}${hash}`, got === expected, got); }
for (const v of F.valueSources) { const got = valueSource(v.value, v.displays.map((text, i) => ({ id: id(i), text }))).source; record('source', v.value, got === v.expected, got); }

const key = process.env.TYPESAFE_API_KEY;
if (!key) console.log('TYPESAFE_API_KEY not set: skipping live Jev cases.');
else {
  const jev = new JevClient({ apiKey: key, model: process.env.JEV_MODEL || 'jev-latest' });
  let tokens = 0;
  const ask = async <K extends JevRequest['kind']>(req: JevRequest & { kind: K }) => {
    const { decision, inputTokens } = await jev.ask(req, AbortSignal.timeout(10000)); tokens += inputTokens;
    return decision as Extract<JevDecision, { kind: K }>;
  };
  const T = JEV_THRESHOLDS;
  await Promise.all([
    ...F.sites.map(async s => { const d = await ask({ kind: 'site', hostname: s.hostname, title: s.title }); const got = d.sensitive >= T.sensitiveSite; record('site', s.hostname, got === s.sensitive, `${d.category}, sensitive ${pct(d.sensitive)}`); }),
    ...F.actions.map(async a => { const d = await ask({ kind: 'action', control: { role: a.role, label: a.label }, recent: [] }); const got = d.probability >= T.action ? d.action : 'unknown'; record('action', a.label, a.expected.includes(got), `${d.action} ${pct(d.probability)}`); }),
    ...F.triage.map(async t => { const d = await ask({ kind: 'triage', episode: t.episode }); const save = d.work >= T.work && d.routine >= T.routine; record('triage', t.name, save === t.save, `${save ? 'save' : 'discard'} · work ${pct(d.work)} routine ${pct(d.routine)} automatable ${pct(d.automatable)}`); }),
    ...F.boundaries.map(async b => { const d = await ask({ kind: 'boundary', episode: b.episode }); const verdict = d.finished >= T.autoClose ? 'auto-close' : d.finished >= T.suggestFinished ? 'suggest' : 'continue'; record('boundary', b.name, b.finished ? verdict !== 'continue' : verdict === 'continue', `${verdict} ${pct(d.finished)}`); }),
    ...F.matches.map(async m => {
      const candidates = m.candidates.map((brief, i) => ({ id: id(i), purpose: null, brief }));
      const d = await ask({ kind: 'match', episode: m.episode, candidates });
      const got = d.probability >= T.match && d.candidateId ? candidates.findIndex(c => c.id === d.candidateId) : null;
      record('match', m.name, got === m.expected, `${got === null ? 'new task' : `candidate ${got}`} ${pct(d.probability)}`);
    }),
    ...F.relevance.map(async r => {
      const outcomeCheck = r.outcome !== undefined;
      const d = await ask({ kind: 'relevance', recent: [], outcomeCheck, content: { kind: r.label === 'Visible page excerpt' ? 'content.display' : 'field.edit', label: r.label, text: r.label === 'Visible page excerpt' ? r.text : '', before: r.label === 'Visible page excerpt' ? null : '', after: r.label === 'Visible page excerpt' ? '' : r.text } });
      const keep = !(d.sensitive >= T.sensitive || !outcomeCheck && d.relevant < T.relevant);
      const outcomeOk = !outcomeCheck || (d.succeeded ?? 0) >= 0.5 === r.outcome;
      record('relevance', r.name, keep === r.keep && outcomeOk, `${keep ? 'keep' : 'drop'} · relevant ${pct(d.relevant)} sensitive ${pct(d.sensitive)} · ${d.pageType}${outcomeCheck ? ` · succeeded ${pct(d.succeeded ?? 0)}` : ''}`);
    }),
  ]);
  console.log(`Live Jev: ${tokens} input tokens (~$${(tokens * 0.042 / 1e6).toFixed(5)}).`);
}

const kinds = [...new Set(results.map(r => r.kind))];
for (const kind of kinds) {
  const rows = results.filter(r => r.kind === kind);
  console.log(`\n${kind}: ${rows.filter(r => r.pass).length}/${rows.length}`);
  for (const r of rows) console.log(`  ${r.pass ? '✓' : '✗'} ${r.name.padEnd(34)} ${r.detail}`);
}
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exitCode = failed ? 1 : 0;
