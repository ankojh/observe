import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { liveQuery } from 'dexie';
import { db, initialConsent, type Consent, type AIJob } from '../storage/db';
import { AgentDefinition as DefinitionSchema, DefinitionInput, WorkflowSummary, type AgentDefinition, type Episode, type Feedback, type ObservedEvent, type Workflow } from '../../../../packages/core/src/schemas';
import { markdown } from '../../../../packages/core/src/definitions';
import { backend, cancelJobs, command, recoverJobs } from './api';
import './style.css';

type Memory = { consent: Consent; events: ObservedEvent[]; episodes: Episode[]; workflows: Workflow[]; feedback: Feedback[]; definitions: AgentDefinition[]; jobs: AIJob[] };
const empty: Memory = { consent: initialConsent(), events: [], episodes: [], workflows: [], feedback: [], definitions: [], jobs: [] };
const duration = (ms: number) => ms < 60000 ? `${Math.round(ms / 1000)}s` : `${(ms / 60000).toFixed(1)}m`;
const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const lines = (s: string) => s.split('\n').map(t => t.trim()).filter(Boolean);
const message = (e: unknown) => e instanceof Error ? e.message : 'Operation failed';

function App() {
  const [memory, setMemory] = useState<Memory>(empty);
  const [tab, setTab] = useState<'Activity' | 'Patterns' | 'Agent drafts'>('Activity');
  const [settings, setSettings] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ origin: string | null; collecting: boolean }>({ origin: null, collecting: false });
  const [siteInput, setSiteInput] = useState('');
  const [pairing, setPairing] = useState('');
  const [health, setHealth] = useState('Not paired');
  const [retainSites, setRetainSites] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [share, setShare] = useState<{ kind: 'analysis' | 'definition'; text: string } | null>(null);
  const [editor, setEditor] = useState<{ id: string; text: string } | null>(null);
  const [exportPreview, setExportPreview] = useState<{ definition: AgentDefinition; format: 'json' | 'md' } | null>(null);
  const [correction, setCorrection] = useState<Record<string, string>>({});
  const [ruleTarget, setRuleTarget] = useState<Record<string, string | undefined>>({});
  useEffect(() => {
    const sub = liveQuery(async () => ({
      consent: (await db.consents.get('state')) ?? initialConsent(), events: await db.events.orderBy('time').reverse().limit(100).toArray(),
      episodes: await db.episodes.orderBy('start').reverse().toArray(), workflows: await db.workflows.toArray(),
      feedback: await db.feedback.toArray(), definitions: await db.definitions.toArray(), jobs: await db.aiJobs.toArray(),
    })).subscribe({ next: setMemory, error: e => setError(`Local memory unavailable: ${message(e)}`) });
    const refresh = () => { void command({ type: 'status' }).then(setStatus).catch(e => setError(message(e))); void recoverJobs(setError); };
    refresh(); const interval = setInterval(refresh, 2500);
    void chrome.storage.local.get('pairingToken').then(c => { if (typeof c.pairingToken === 'string') { setPairing(c.pairingToken); setHealth('Token saved; check connection'); } });
    return () => { sub.unsubscribe(); clearInterval(interval); };
  }, []);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(''); try { await fn(); } catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  const send = (payload: unknown) => run(() => command(payload));
  const alias = (id: string) => memory.consent.sites.find(s => s.id === id)?.alias ?? 'Removed app';
  const approveSite = async () => {
    const origin = status.origin ?? siteInput;
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.origin === 'http://127.0.0.1:4317') throw new Error('Enter an ordinary HTTP(S) site origin; backend access is separate.');
    const pattern = `${url.protocol}//${url.hostname}/*`;
    // Called directly from the click, before awaiting other work: runtime permission user gesture.
    if (!await chrome.permissions.request({ origins: [pattern] })) throw new Error('Site permission not granted');
    await command({ type: 'site.grant', origin: url.origin });
  };
  const openShare = async (w: Workflow, kind: 'analysis' | 'definition') => {
    const result = await command({ type: 'summary', workflowId: w.id });
    const { ok: _ok, ...summary } = result;
    const payload = kind === 'analysis' ? WorkflowSummary.parse(summary) : DefinitionInput.parse({ summary, interpretation: w.interpretation?.result ?? null, interpretationVersion: w.interpretation?.version ?? 0 });
    setShare({ kind, text: JSON.stringify(payload, null, 2) });
  };
  const feedback = async (w: Workflow, kind: 'intent' | 'rule' | 'dismiss' | 'restore' | 'exclude', episodeId?: string) => {
    if (['intent', 'rule', 'exclude'].includes(kind) && !window.confirm('This correction will invalidate existing drafts and pending AI requests for this pattern. Continue?')) return;
    // Gate first; late AI responses cannot overwrite this correction.
    const jobs = memory.jobs.filter(j => j.workflowId === w.id);
    await command({ type: 'feedback', workflowId: w.id, kind, text: correction[w.id] ?? '', ...(episodeId ? { episodeId } : {}), ...(kind === 'rule' && ruleTarget[w.id] ? { supersedes: ruleTarget[w.id] } : {}) });
    void cancelJobs(jobs); setCorrection(c => ({ ...c, [w.id]: '' })); setRuleTarget(t => ({ ...t, [w.id]: undefined }));
  };
  const reset = async () => {
    if (!window.confirm('Pause and erase ALL local events, patterns, corrections, jobs, and drafts? Provider retention and exported files cannot be erased by this action.')) return;
    const jobs = memory.jobs;
    await command({ type: 'reset', retainSites });
    setEditor(null); setShare(null); setExportPreview(null); setExpanded(null);
    void cancelJobs(jobs);
  };
  const exportFile = async () => {
    if (!exportPreview) return;
    const current = await db.definitions.get(exportPreview.definition.id);
    if (!current || JSON.stringify(current) !== JSON.stringify(exportPreview.definition)) throw new Error('Draft changed or was deleted. Preview it again.');
    const d = DefinitionSchema.parse(current);
    const text = exportPreview.format === 'json' ? JSON.stringify(d, null, 2) : markdown(d);
    const url = URL.createObjectURL(new Blob([text], { type: exportPreview.format === 'json' ? 'application/json' : 'text/markdown' }));
    const link = document.createElement('a'); link.href = url; link.download = `observe-${d.id.slice(0, 8)}-v${d.version}.${exportPreview.format}`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000); setExportPreview(null);
  };
  const currentApproved = memory.consent.sites.some(s => s.origin === status.origin);
  const stateLabel = memory.consent.error ? 'Capture error' : !memory.consent.enabled ? 'Observation paused' : status.collecting ? 'Observing approved site' : 'Enabled · no capture here';
  const completed = memory.episodes.filter(e => e.closed).length;
  const priority = (w: Workflow) => {
    const episodes = memory.episodes.filter(e => w.occurrenceIds.includes(e.id));
    const totalMs = episodes.reduce((n, e) => n + e.activeMs, 0);
    const gapCount = episodes.reduce((n, e) => n + e.gaps.length, 0);
    return totalMs / (1 + gapCount);
  };
  const ranked = [...memory.workflows].sort((a, b) => priority(b) - priority(a) || b.occurrenceIds.length - a.occurrenceIds.length);
  return <>
    <header>
      <div className="brand"><span className="brandmark">◉</span><div><h1>Observe<span className="mvp">LOCAL FIRST</span></h1><p>Turn repeated work into a considered draft.</p></div><button className="icon" aria-label="Settings" onClick={() => setSettings(!settings)}>⚙</button></div>
      <div className={`status ${status.collecting ? 'on' : ''}`}><span className="dot"/><span>{stateLabel}</span><button disabled={busy} onClick={() => send({ type: 'consent.toggle', enabled: !memory.consent.enabled })}>{memory.consent.enabled ? 'Pause' : 'Start'}</button></div>
      <nav>{(['Activity', 'Patterns', 'Agent drafts'] as const).map(t => <button key={t} className={tab === t ? 'selected' : ''} onClick={() => setTab(t)}>{t}{t === 'Patterns' && memory.workflows.length > 0 && <i>{memory.workflows.length}</i>}</button>)}</nav>
    </header>
    <main>
      {error && <div className="alert" role="alert"><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss error">×</button></div>}
      {memory.consent.error && <div className="alert">{memory.consent.error}</div>}
      {settings && <section className="card settings"><div className="sectiontitle"><h2>Settings & privacy</h2><button onClick={() => setSettings(false)}>Done</button></div>
        <h3>Approved sites · local only</h3><p className="muted">Hosts stay in this installation. Permissions cover the exact scheme and host (all paths and ports), not subdomains. Capture additionally requires an exact approved origin, including port.</p>
        {memory.consent.sites.map(s => <div className="site" key={s.id}><code>{s.origin}</code><div className="row"><input aria-label="App alias" defaultValue={s.alias} maxLength={80} onBlur={e => { if (e.target.value !== s.alias) void send({ type: 'site.alias', siteId: s.id, alias: e.target.value }); }}/><button className="danger" disabled={busy} onClick={() => send({ type: 'site.revoke', siteId: s.id })}>Revoke</button></div></div>)}
        <h3>Backend pairing</h3><p className="muted">Loopback only: <code>127.0.0.1:4317</code>. This permission is separate from site observation. Token stays in trusted extension storage and is never exported.</p>
        <p className="muted">Extension origin: <code className="break">{location.origin}</code></p>
        <input type="password" autoComplete="off" placeholder="Paste pairing token from backend token file" value={pairing} onChange={e => setPairing(e.target.value)}/>
        <div className="row"><button disabled={busy} onClick={() => run(async () => {
          if (!/^[a-f0-9]{64}$/.test(pairing.trim())) throw new Error('Expected the 64-character backend pairing token.');
          if (!await chrome.permissions.request({ origins: ['http://127.0.0.1/*'] })) throw new Error('Backend permission denied');
          await chrome.storage.local.set({ pairingToken: pairing.trim() });
          const result = await backend('/health'); setHealth(result.configured ? `Live OpenAI ready · ${result.model}` : 'Connected · live AI disabled until server configuration is complete');
        })}>Pair & check</button><button onClick={() => run(async () => { await chrome.storage.local.remove('pairingToken'); setPairing(''); setHealth('Not paired'); })}>Forget token</button></div><p className="note">{health}</p>
        <h3>Retention & deletion</h3><label>Evidence retention <select value={memory.consent.retentionDays} onChange={e => send({ type: 'retention', days: Number(e.target.value) })}>{[1, 3, 7, 14, 30].map(d => <option key={d} value={d}>{d} days</option>)}</select></label>
        <p className="muted">10,000-event cap. Aging evidence invalidates dependent episodes, interpretations, and drafts. Backend results expire after 24 hours. OpenAI account retention is governed by your account terms, not local reset.</p>
        <label className="check"><input type="checkbox" checked={retainSites} onChange={e => setRetainSites(e.target.checked)}/>Keep site approvals after reset (observation remains paused)</label>
        <button className="danger" disabled={busy} onClick={() => run(reset)}>Pause & delete all local data</button>
      </section>}
      {tab === 'Activity' && <>
        <section className="intro"><span className="eyebrow">01 / OBSERVE</span><h2>Evidence before assumptions.</h2><p>Only safe interaction categories. No field values, page text, full URLs, or background-tab activity.</p></section>
        <section className="card"><div className="sectiontitle"><h3>This site</h3><span className={`pill ${currentApproved ? 'green' : ''}`}>{currentApproved ? 'Approved' : 'Not approved'}</span></div>
          <code className="break">{status.origin ?? 'Current site URL unavailable — enter its origin below'}</code>
          {!status.origin && <input placeholder="https://example.com" value={siteInput} onChange={e => setSiteInput(e.target.value)}/>}
          {!currentApproved && <button className="primary full" disabled={busy || (!status.origin && !siteInput)} onClick={() => run(approveSite)}>Approve this scheme & host</button>}
          <p className="muted">Declaring optional HTTP(S) capability does not grant access to every site. You choose each host.</p>
        </section>
        <div className="metrics"><div><b>{memory.events.length >= 100 ? '100+' : memory.events.length}</b><span>recent events</span></div><div><b>{completed}</b><span>completed episodes</span></div><div><b>{memory.consent.sites.length}</b><span>approved origins</span></div></div>
        <section className="card"><div className="sectiontitle"><h3>Episode boundaries</h3><button disabled={busy || !memory.episodes.some(e => !e.closed)} onClick={() => send({ type: 'episode.end' })}>End episode</button></div><p className="muted">Mark each task complete. Cross-tab activity on approved apps can stay together; idle, unobserved intervals, pause, and loss of browser focus split it.</p>
          {!memory.episodes.length && <Empty title="Your first episode starts here" text="Approve a site, start observation, and use ordinary buttons or forms. Then mark the episode complete."/>}
          {memory.episodes.slice(0, 20).map(e => <div className="episode" key={e.id}><div className="row"><button className="textbutton" onClick={() => setExpanded(expanded === e.id ? null : e.id)}>{e.closed ? '◇' : '●'} {clock(e.start)} · {e.eventIds.length} events</button><span className="muted">≈ {duration(e.activeMs)}</span></div><p className="note">{e.closed ? e.reason : 'Recording · not yet counted as an occurrence'}</p>
            {expanded === e.id && <><TokenList tokens={e.tokens} alias={alias}/>{e.gaps.length > 0 && <p className="note">Gaps: {e.gaps.join('; ')}</p>}<button className="danger" onClick={() => run(async () => {
              if (!window.confirm('Delete this episode and invalidate dependent drafts and analysis?')) return;
              const jobs = memory.jobs;
              await command({ type: 'episode.delete', id: e.id }); void cancelJobs(jobs.filter(j => memory.workflows.some(w => w.id === j.workflowId && w.occurrenceIds.includes(e.id))));
            })}>Delete episode evidence</button></>}
          </div>)}
        </section>
        <section className="card"><div className="sectiontitle"><h3>Recorded timeline</h3><span className="pill">OBSERVED</span></div><p className="muted">Latest 100 minimized events, newest first. Submit means an attempt, not success.</p>
          {memory.events.length === 0 ? <p className="muted">No observations stored.</p> : <div className="timeline">{memory.events.map(e => <div className="event" key={e.id}><time>{clock(e.time)}</time><div><strong>{alias(e.siteId)}</strong><p>{e.category}{e.action !== 'unknown' ? ` · ${e.action}` : ''}</p></div><span title="Observed">↳</span></div>)}</div>}
        </section>
      </>}
      {tab === 'Patterns' && <>
        <section className="intro"><span className="eyebrow">02 / RECOGNIZE & CONFIRM</span><h2>Repetition, not certainty.</h2><p>Local sequence matching finds candidates. Hosted interpretation happens only after you review the exact summary.</p></section>
        {!memory.workflows.length && <Empty title="Let the evidence accumulate" text="Complete three similar episodes to enable hosted analysis. Two meaningful safe actions are needed; site order alone never establishes a pattern."/>}
        {memory.workflows.length > 0 && <p className="muted">Priority: occurrences × mean approximate active time ÷ (1 + known capture gaps). Feasibility is not confirmed and capabilities remain unverified.</p>}
        {ranked.map(w => {
          const occurrences = memory.episodes.filter(e => w.occurrenceIds.includes(e.id));
          const intent = memory.feedback.filter(f => f.workflowId === w.id && f.type === 'intent').sort((a, b) => b.version - a.version)[0];
          const superseded = new Set(memory.feedback.filter(f => f.workflowId === w.id).map(f => f.supersedes));
          const rules = memory.feedback.filter(f => f.workflowId === w.id && f.type === 'rule' && !superseded.has(f.id));
          const suppressed = w.dismissedAtCount !== null && w.occurrenceIds.length < w.dismissedAtCount + 3;
          const jobs = memory.jobs.filter(j => j.workflowId === w.id).sort((a, b) => b.time - a.time);
          const active = jobs.some(j => ['approved', 'pending', 'running'].includes(j.state));
          const mean = occurrences.length ? occurrences.reduce((n, e) => n + e.activeMs, 0) / occurrences.length : 0;
          return <section className={`card pattern ${suppressed ? 'dimmed' : ''}`} key={w.id}>
            <div className="sectiontitle"><span className="eyebrow">{suppressed ? 'DISMISSED' : occurrences.length >= 3 ? 'READY FOR REVIEW' : occurrences.length === 2 ? 'EMERGING PATTERN' : 'CANDIDATE'}</span><span className="pill">{occurrences.length} occurrences</span></div>
            <h3>{intent?.text ?? w.interpretation?.result.name ?? 'Repeated interaction sequence'}</h3>
            <p className="note">{intent ? 'USER-CONFIRMED INTENT' : w.interpretation ? 'INFERRED · hosted OpenAI' : 'LOCAL HEURISTIC · purpose unknown'}</p>
            <div className="facts"><span>≈ {duration(mean)} active / occurrence</span><span>Last match {Math.round(w.score * 100)} / 100</span></div>
            <p className="muted">Timing is approximate; match scores are not probabilities. Evidence spans {occurrences.length ? Math.max(0, (Math.max(...occurrences.map(e => e.end)) - Math.min(...occurrences.map(e => e.start))) / 86400000).toFixed(2) : '0'} days. No weekly projection.</p>
            {w.interpretation && <div className="interpretation"><p>{w.interpretation.result.purpose}</p><p className="note">Interpretation v{w.interpretation.version} · based on {w.interpretation.occurrenceCount} occurrences, feedback v{w.interpretation.feedbackVersion}. {(w.interpretation.occurrenceCount !== occurrences.length || w.interpretation.feedbackVersion !== w.feedbackVersion) ? 'OUTDATED — new evidence/corrections need fresh approval.' : 'Inferred business intent requires your review.'}</p>
              {w.interpretation.result.claims.map((c, i) => <div className="claim" key={i}><span className="pill">{c.source}</span><p>{c.statement}</p><small>{c.uncertainty} · evidence {c.evidenceRefs.map(r => r.slice(0, 8)).join(', ')}</small></div>)}
              <details><summary>Alternatives, boundary & blockers</summary><p>{w.interpretation.result.alternatives.join('; ') || 'No alternatives proposed.'}</p><p>{w.interpretation.result.automationBoundary}</p><p>{w.interpretation.result.feasibility}</p><ul>{w.interpretation.result.blockers.map((q, i) => <li key={i}>{q}</li>)}</ul><h4>Unresolved questions</h4><ul>{w.interpretation.result.questions.map((q, i) => <li key={i}>{q}</li>)}</ul></details>
            </div>}
            {(w.interpretationHistory?.length ?? 0) > 0 && <details><summary>Prior interpretation provenance</summary>{w.interpretationHistory!.map(i => <div className="variant" key={i.version}><p className="note">v{i.version} · {i.occurrenceCount} occurrences · feedback v{i.feedbackVersion} · superseded, not current evidence</p><h4>{i.result.name}</h4><p>{i.result.purpose}</p><pre className="preview">{JSON.stringify(i.result, null, 2)}</pre></div>)}</details>}
            <details><summary>Inspect occurrences & variants</summary>{occurrences.map(e => <div className="variant" key={e.id}><p className="note">{clock(e.start)} · {e.id.slice(0, 8)} · ≈ {duration(e.activeMs)}</p><TokenList tokens={e.tokens} alias={alias}/><button className="danger" disabled={busy} onClick={() => run(() => feedback(w, 'exclude', e.id))}>This occurrence is unrelated</button></div>)}</details>
            <div className="correction"><h4>Your confirmed constraints</h4>{intent && <p><span className="pill green">Intent</span> {intent.text}</p>}{rules.map(r => <p key={r.id}><span className="pill green">Rule v{r.version}</span> {r.text} <button className="textbutton" onClick={() => { setRuleTarget(t => ({ ...t, [w.id]: r.id })); setCorrection(c => ({ ...c, [w.id]: r.text })); }}>Correct</button></p>)}
              <textarea maxLength={1200} placeholder="Correct the purpose, or add a business rule…" value={correction[w.id] ?? ''} onChange={e => setCorrection(c => ({ ...c, [w.id]: e.target.value }))}/>
              <div className="row"><button disabled={busy || !correction[w.id]?.trim()} onClick={() => run(() => feedback(w, 'intent'))}>Confirm intent</button><button disabled={busy || !correction[w.id]?.trim() || rules.length >= 39 && !ruleTarget[w.id]} onClick={() => run(() => feedback(w, 'rule'))}>{ruleTarget[w.id] ? 'Confirm corrected rule' : 'Add rule'}</button></div>
              <p className="muted">Corrections apply only to this group and future matched occurrences. They invalidate existing drafts to avoid silently overwriting edits.</p>
            </div>
            {jobs.slice(0, 2).map(j => <p className={`job ${j.state === 'failed' ? 'failed' : ''}`} key={j.id}>{j.kind === 'analysis' ? 'Interpretation' : 'Definition'} · {j.state}{j.error && ` — ${j.error}`}</p>)}
            <div className="row wrap"><button className="primary" disabled={busy || active || suppressed || occurrences.length < 3} onClick={() => run(() => openShare(w, 'analysis'))}>Review & analyze</button><button disabled={busy || !occurrences.length} onClick={() => run(async () => { await command({ type: 'draft.manual', workflowId: w.id }); setTab('Agent drafts'); })}>Local manual draft</button></div>
            <div className="row wrap"><button disabled={busy || active || suppressed || !w.interpretation} onClick={() => run(() => openShare(w, 'definition'))}>Review AI draft request</button><button className="textbutton" disabled={busy} onClick={() => run(() => feedback(w, w.dismissedAtCount !== null ? 'restore' : 'dismiss'))}>{w.dismissedAtCount !== null ? 'Restore recommendation' : 'Dismiss'}</button></div>
            {suppressed && <p className="muted">Suppressed until restored or three additional occurrences are recorded.</p>}
          </section>;
        })}
      </>}
      {tab === 'Agent drafts' && <>
        <section className="intro"><span className="eyebrow">03 / DEFINE & EXPORT</span><h2>A definition. Not an execution.</h2><p>Edit intent and rules, leave unknowns explicit, and export a portable proposal. Every capability remains unverified.</p></section>
        {!memory.definitions.length && <Empty title="Nothing deploys itself" text="Create a local manual draft from a pattern, or approve a separate hosted draft request after interpretation."/>}
        {memory.definitions.map(d => <section className="card" key={d.id}><div className="sectiontitle"><span className="pill">{d.status.replaceAll('_', ' ')}</span><span className="note">v{d.version} · {d.provenance.source}</span></div><h3>{d.title}</h3><p>{d.goal}</p><p className="note">{d.provenance.occurrenceCount} observed occurrences · feedback v{d.provenance.feedbackVersion}</p>
          {d.questions.length > 0 && <div className="questions"><h4>{d.questions.length} unresolved questions</h4><ul>{d.questions.map((q, i) => <li key={i}>{q}</li>)}</ul></div>}
          <div className="row wrap"><button onClick={() => setEditor({ id: d.id, text: JSON.stringify(d, null, 2) })}>Edit definition</button><button onClick={() => setExportPreview({ definition: d, format: 'json' })}>Preview JSON</button><button onClick={() => setExportPreview({ definition: d, format: 'md' })}>Preview Markdown</button></div>
          <p className="muted">No verified connector, browser replay, execution, or deployment. Local evidence references do not travel with the export.</p>
        </section>)}
      </>}
      <footer>Observed ≠ inferred ≠ user-confirmed.<br/>Local matching never uploads your activity.</footer>
    </main>
    {share && <Modal error={error} title={share.kind === 'analysis' ? 'Review hosted interpretation request' : 'Review hosted definition request'} close={() => setShare(null)}>
      <p>Only the exact JSON below will be sent to your loopback backend, then OpenAI. Raw events and approved hosts are excluded. User-entered aliases and corrections may still be sensitive.</p><div className="notice">No request has been sent. Redact aliases or correction wording below. Factual fields cannot be edited. OpenAI retention depends on your approved account terms.</div>
      <textarea className="json" spellCheck={false} value={share.text} onChange={e => setShare({ ...share, text: e.target.value })}/>
      <p className="muted">Every change requires a new approval. Your click approves this exact version only.</p>
      <button className="primary full" disabled={busy} onClick={() => run(async () => {
        const payload = JSON.parse(share.text); await command({ type: 'job.approve', kind: share.kind, payload }); setShare(null); void recoverJobs(setError);
      })}>Approve this payload & send to OpenAI</button>
    </Modal>}
    {editor && <Modal error={error} title="Edit agent definition" close={() => setEditor(null)}>
      <p>Review goal, inputs, steps, rules, and questions. Nothing here runs. Evidence provenance is read-only; changing facts requires a fresh draft.</p>
      <DraftFields text={editor.text} change={text => setEditor({ ...editor, text })}/>
      <details><summary>Full versioned JSON editor</summary><textarea className="json" spellCheck={false} value={editor.text} onChange={e => setEditor({ ...editor, text: e.target.value })}/></details>
      <button className="primary full" disabled={busy} onClick={() => run(async () => { await command({ type: 'draft.save', definition: JSON.parse(editor.text) }); setEditor(null); })}>Validate & save new version</button>
    </Modal>}
    {exportPreview && <Modal error={error} title={`Final ${exportPreview.format === 'json' ? 'JSON' : 'Markdown'} privacy preview`} close={() => setExportPreview(null)}>
      <div className="notice">This is a {exportPreview.definition.status.replaceAll('_', ' ')} with {exportPreview.definition.questions.length} unresolved questions. NOT executable or deployed. Check user-entered information for secrets. Exported files cannot be recalled by local reset.</div>
      <pre className="preview">{exportPreview.format === 'json' ? JSON.stringify(exportPreview.definition, null, 2) : markdown(exportPreview.definition)}</pre>
      <button className="primary full" disabled={busy} onClick={() => run(exportFile)}>Export reviewed {exportPreview.format.toUpperCase()} file</button>
    </Modal>}
  </>;
}
function TokenList({ tokens, alias }: { tokens: string[]; alias: (id: string) => string }) {
  return <ol className="tokens">{tokens.map((t, i) => { const [app, category, action] = t.split('|'); return <li key={i}><strong>{alias(app)}</strong> <span>{category}{action !== 'unknown' ? ` → ${action}` : ''}</span></li>; })}</ol>;
}
function Empty({ title, text }: { title: string; text: string }) { return <div className="empty"><span>◌</span><h3>{title}</h3><p>{text}</p></div>; }
function Modal({ title, close, children, error }: { title: string; close: () => void; children: React.ReactNode; error?: string }) {
  return <div className="overlay"><section className="modal" role="dialog" aria-modal="true" aria-label={title}><div className="sectiontitle"><h2>{title}</h2><button aria-label="Close" onClick={close}>×</button></div>{error && <div className="alert" role="alert">{error}</div>}{children}</section></div>;
}
function DraftFields({ text, change }: { text: string; change: (text: string) => void }) {
  let d: AgentDefinition;
  try { d = JSON.parse(text); } catch { return <p className="alert">Fix the JSON below to restore the form editor.</p>; }
  const update = (patch: Partial<AgentDefinition>) => change(JSON.stringify({ ...d, ...patch }, null, 2));
  if (!d || typeof d.title !== 'string' || typeof d.goal !== 'string' || typeof d.description !== 'string' || !Array.isArray(d.nonGoals) || !d.nonGoals.every(s => typeof s === 'string') || !Array.isArray(d.inputs) || !d.inputs.every(i => i && typeof i.name === 'string' && typeof i.description === 'string') || !Array.isArray(d.steps) || !d.steps.length || !d.steps.every(s => s && typeof s.instruction === 'string') || !Array.isArray(d.rules) || !d.rules.every(r => r && typeof r.text === 'string') || !Array.isArray(d.questions) || !d.questions.every(s => typeof s === 'string') || !d.savings) return <p className="alert">Restore required fields in the JSON editor.</p>;
  return <div className="draftform"><label>Title<input value={d.title} onChange={e => update({ title: e.target.value })}/></label><label>Goal<textarea value={d.goal} onChange={e => update({ goal: e.target.value })}/></label><label>Description<textarea value={d.description} onChange={e => update({ description: e.target.value })}/></label>
    <label>Non-goals (one per line)<textarea value={d.nonGoals.join('\n')} onChange={e => update({ nonGoals: lines(e.target.value) })}/></label>
    <h3>Inputs</h3>{d.inputs.map((input, i) => <div className="inputrow" key={i}><input aria-label="Input name" value={input.name} onChange={e => update({ inputs: d.inputs.map((v, n) => n === i ? { ...v, name: e.target.value } : v) })}/><select value={input.type} onChange={e => update({ inputs: d.inputs.map((v, n) => n === i ? { ...v, type: e.target.value as typeof input.type } : v) })}>{['string', 'number', 'boolean', 'object', 'array'].map(t => <option key={t}>{t}</option>)}</select><label className="check"><input type="checkbox" checked={input.required} onChange={e => update({ inputs: d.inputs.map((v, n) => n === i ? { ...v, required: e.target.checked } : v) })}/>Required</label><textarea aria-label="Input description" value={input.description} onChange={e => update({ inputs: d.inputs.map((v, n) => n === i ? { ...v, description: e.target.value } : v) })}/><button onClick={() => update({ inputs: d.inputs.filter((_, n) => n !== i) })}>Remove input</button></div>)}
    <button onClick={() => update({ inputs: [...d.inputs, { name: 'Required input', type: 'string', required: true, description: 'Specify what the eventual agent needs; do not paste observed values.' }] })}>Add input</button>
    <h3>Ordered steps</h3>{d.steps.map((step, i) => <label key={i}>{step.id}<textarea value={step.instruction} onChange={e => update({ steps: d.steps.map((v, n) => n === i ? { ...v, instruction: e.target.value } : v) })}/></label>)}
    <button onClick={() => update({ steps: [...d.steps, { id: `step-${d.steps.length + 1}`, instruction: 'Describe a semantic step, not browser code.', dependsOn: [d.steps[d.steps.length - 1].id], evidenceRefs: [] }] })}>Add semantic step</button>
    <h3>Business rules</h3>{d.rules.map((r, i) => <label key={i}>{r.source}<textarea value={r.text} readOnly={r.source === 'user-confirmed'} onChange={e => update({ rules: d.rules.map((v, n) => n === i ? { ...v, text: e.target.value } : v) })}/></label>)}<p className="muted">Correct confirmed business rules in Patterns so later drafts inherit them.</p>
    <button onClick={() => update({ rules: [...d.rules, { text: 'Proposed rule — review required.', source: 'proposed' }] })}>Add proposed rule</button>
    <label>Unresolved questions (one per line)<textarea value={d.questions.join('\n')} onChange={e => update({ questions: lines(e.target.value), status: 'needs_clarification' })}/></label>
    <label>Status<select value={d.status} onChange={e => update({ status: e.target.value as AgentDefinition['status'] })}><option value="draft">Draft</option><option value="needs_clarification">Needs clarification</option><option value="reviewed_definition">Reviewed definition (questions must be resolved)</option></select></label>
    <label>Assumed remaining human review time (milliseconds)<input type="number" min={0} value={d.savings.remainingHumanReviewMs} onChange={e => update({ savings: { ...d.savings, remainingHumanReviewMs: Number(e.target.value) } })}/></label>
  </div>;
}

createRoot(document.getElementById('root')!).render(<App/>);
