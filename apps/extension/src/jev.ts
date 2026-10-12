import { JevDecision, JEV_LIMITS, type JevRequest } from '../../../packages/core/src/jev';

const BACKEND = 'http://127.0.0.1:4317';
export type JevStatus = { state: 'off' | 'unpaired' | 'unavailable' | 'ready' | 'error'; detail: string; model: string | null; decisions: number };
let status: JevStatus = { state: 'unpaired', detail: 'Pair the backend to enable Jev.', model: null, decisions: 0 };
let retryAt = 0;
export const jevStatus = () => status;

/** Live decision via the paired loopback backend. Returns null whenever Jev cannot decide; callers fall back to local rules. */
export async function jevDecide<K extends JevRequest['kind']>(request: JevRequest & { kind: K }): Promise<Extract<JevDecision, { kind: K }> | null> {
  const { pairingToken, jevEnabled } = await chrome.storage.local.get(['pairingToken', 'jevEnabled']);
  if (jevEnabled === false) { status = { ...status, state: 'off', detail: 'Turned off in Settings. Local rules decide.' }; return null; }
  if (typeof pairingToken !== 'string') { status = { ...status, state: 'unpaired', detail: 'Pair the backend to enable Jev.' }; return null; }
  if (Date.now() < retryAt) return null;
  try {
    const response = await fetch(`${BACKEND}/jev`, {
      method: 'POST', signal: AbortSignal.timeout(JEV_LIMITS.timeoutMs),
      headers: { Authorization: `Bearer ${pairingToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(request),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      // Disabled/unauthorized backends are rechecked after a minute; transient failures after a few seconds.
      retryAt = Date.now() + ([401, 403, 503].includes(response.status) ? 60000 : 5000);
      status = { ...status, state: response.status === 503 ? 'unavailable' : 'error', detail: String(body.error ?? `Backend returned ${response.status}`).slice(0, 200) };
      return null;
    }
    const decision = JevDecision.parse(body);
    if (decision.kind !== request.kind) throw new Error('Mismatched Jev decision');
    status = { state: 'ready', detail: 'Live decisions active.', model: decision.model, decisions: status.decisions + 1 };
    return decision as Extract<JevDecision, { kind: K }>;
  } catch {
    retryAt = Date.now() + 5000;
    status = { ...status, state: 'unavailable', detail: 'Backend unreachable; local rules decide.' };
    return null;
  }
}
