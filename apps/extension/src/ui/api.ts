import { db, type AIJob } from '../storage/db';
export const BACKEND = 'http://127.0.0.1:4317';
export async function command<T = any>(message: unknown): Promise<T> {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error ?? 'Extension worker unavailable');
  return response as T;
}
export async function backend(path: string, method = 'GET', body?: unknown): Promise<any> {
  const { pairingToken } = await chrome.storage.local.get('pairingToken');
  if (!pairingToken) throw new Error('Pair the backend in Settings first.');
  const response = await fetch(`${BACKEND}${path}`, { method,
    headers: { Authorization: `Bearer ${pairingToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `Backend request failed (${response.status})`);
  return result;
}
let processing = false;
/** Panel-owned short requests. Approved jobs persist; reopening recovers via idempotent job ID. */
export async function recoverJobs(report: (error: string) => void) {
  if (processing) return;
  processing = true;
  try {
    const jobs = (await db.aiJobs.toArray()).filter(j => ['approved', 'pending', 'running'].includes(j.state));
    for (const job of jobs) {
      try {
        await command({ type: 'job.check', id: job.id });
        if (job.state === 'approved') {
          await backend(job.kind === 'analysis' ? '/analysis-jobs' : '/definition-jobs', 'POST', { requestId: job.id, kind: job.kind, payload: job.payload, approval: true });
          await command({ type: 'job.update', id: job.id, state: 'pending' });
        }
        const result = await backend(`/jobs/${job.id}`);
        await command({ type: 'job.update', id: job.id, state: result.state, ...(result.result ? { result: result.result } : {}), ...(result.error ? { error: result.error } : {}) });
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Backend request failed';
        if (e instanceof TypeError || e instanceof DOMException) report('Backend unavailable; approved jobs remain saved and will reconnect while this panel is open.');
        else {
          try { await command({ type: 'job.update', id: job.id, state: 'failed', error: message.slice(0, 300) }); } catch { /* Reset/exclusion invalidated this job. */ }
          report(message);
        }
      }
    }
  } finally { processing = false; }
}
export async function cancelJobs(jobs: AIJob[]) {
  // Best effort only. Local generation checks are authoritative even if cancellation cannot reach the server.
  await Promise.all(jobs.map(j => backend(`/jobs/${j.id}`, 'DELETE').catch(() => undefined)));
}
