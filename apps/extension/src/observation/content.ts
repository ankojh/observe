import { ContentPayload, EventPayload, type EventPayload as Payload } from '../../../../packages/core/src/schemas';
import { createContextCapture } from './context';

// Isolated-world singleton. Dynamic registration + injection must not duplicate listeners.
const marker = '__observeCaptureV2';
const globals = globalThis as unknown as Record<string, unknown>;
if (!globals[marker] && window.top === window) {
  globals[marker] = true;
  const documentId = crypto.randomUUID();
  let sequence = 0, enabled = false, epoch = -1, lastLocation = '';
  let poll: ReturnType<typeof setInterval> | undefined;
  let inFlight = 0;
  const context = createContextCapture(async (data, sessionId) => {
    if (!enabled || document.hidden || inFlight >= 8) return;
    const payload = ContentPayload.parse({ id: crypto.randomUUID(), document: documentId, sequence: sequence++, epoch, visible: true, sessionId, data });
    inFlight++;
    try { await chrome.runtime.sendMessage({ type: 'capture.context', payload }); } finally { inFlight--; }
  });
  const allowed: Record<string, Payload['action']> = {
    open: 'open', search: 'search', save: 'save', edit: 'edit', next: 'next', back: 'back',
    reply: 'reply', send: 'send', cancel: 'cancel', delete: 'delete', add: 'add', close: 'close',
  };
  const editable = (el: Element) => !!el.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="combobox"],[role="searchbox"]');
  function classify(el: Element): Payload['action'] {
    // Never read a value or label from an editable element or descendant.
    if (editable(el) || el.querySelector('input,textarea,select,[contenteditable]:not([contenteditable="false"])')) return 'unknown';
    // Only a control's own short label; no ancestors / adjacent prose / selectors are emitted.
    let label = el.getAttribute('aria-label');
    if (label === null) {
      label = '';
      for (const node of el.childNodes) {
        // Rich nested controls degrade to unknown; inspect only bounded direct text.
        if (node.nodeType !== Node.TEXT_NODE || (node.textContent?.length ?? 0) + label.length > 24) return 'unknown';
        label += node.textContent ?? '';
      }
    }
    if (label.length > 24) return 'unknown';
    return Object.hasOwn(allowed, label.trim().toLowerCase()) ? allowed[label.trim().toLowerCase()] : 'unknown';
  }
  /** Short accessible name of a non-editable control, sent only for Jev classification of unknown actions. */
  function hintFor(el: Element): string | undefined {
    if (el.querySelector('input,textarea,select,[contenteditable]:not([contenteditable="false"])')) return;
    const raw = el.getAttribute('aria-label') ?? el.getAttribute('title') ?? (el.textContent ?? '').slice(0, 400);
    const text = raw.replace(/\s+/g, ' ').trim().slice(0, 120);
    return text || undefined;
  }
  async function emit(category: Payload['category'], action: Payload['action'] = 'unknown', role: Payload['role'] = 'page', hint?: string) {
    if (!enabled || (document.hidden && category !== 'page.visibility_change')) return;
    if (inFlight >= 8) { void chrome.runtime.sendMessage({ type: 'capture.gap', epoch }).catch(() => {}); return; }
    const payload = EventPayload.parse({ id: crypto.randomUUID(), document: documentId, sequence: sequence++, epoch, category, action, role, visible: !document.hidden, ...(hint ? { hint } : {}) });
    inFlight++;
    try {
      // One idempotent retry only while the same epoch is still enabled. No offline backlog.
      for (let attempt = 0; attempt < 2 && enabled && epoch === payload.epoch; attempt++) {
        try {
          const result = await chrome.runtime.sendMessage({ type: 'capture.event', payload });
          if (result?.ok || result?.disabled) break;
          if (!result?.retry) break;
        } catch { if (attempt === 1) enabled = false; }
      }
    } finally { inFlight--; }
  }
  function checkRoute() {
    if (!enabled || document.hidden) return;
    const next = location.href; // transient only; no URL hashes, routes, or titles persisted.
    if (next !== lastLocation) { lastLocation = next; void emit('page.route_change'); context.route(); }
  }
  function configure(config: { enabled?: boolean; epoch?: number; content?: { id: string; expiresAt: number } | null }) {
    if ((config.epoch ?? -1) < epoch) return; // An old hello response cannot undo a newer consent broadcast.
    const wasEnabled = enabled;
    const previousEpoch = epoch;
    enabled = config.enabled === true; epoch = config.epoch ?? -1;
    if (poll) clearInterval(poll);
    poll = undefined;
    if (!enabled) lastLocation = '';
    if (enabled && !document.hidden) poll = setInterval(checkRoute, 1000);
    context.configure(enabled ? config.content ?? null : null);
    if (enabled && (!wasEnabled || previousEpoch !== epoch)) { lastLocation = location.href; void emit('page.enter'); }
  }
  chrome.runtime.onMessage.addListener((message, _sender, reply) => {
    if (message?.type === 'capture.config') configure(message);
    if (message?.type === 'capture.flush') { void context.flush().then(() => reply({ ok: true }), () => reply({ ok: false })); return true; }
    if (message?.type === 'capture.boundary') context.boundary();
  });
  window.addEventListener('click', event => {
    if (!enabled || !event.isTrusted || !(event.target instanceof Element) || editable(event.target)) return;
    const el = event.target.closest('button,a,[role="button"],[role="link"]');
    if (!el || editable(el)) return;
    const action = classify(el);
    void emit('control.activate', action, el.matches('a,[role="link"]') ? 'link' : 'button', action === 'unknown' ? hintFor(el) : undefined);
  }, true);
  document.addEventListener('submit', event => {
    if (enabled && event.isTrusted) void emit('form.submit_attempt', 'unknown', 'form');
  }, true);
  document.addEventListener('visibilitychange', () => {
    void emit('page.visibility_change');
    if (poll) clearInterval(poll);
    poll = enabled && !document.hidden ? setInterval(checkRoute, 1000) : undefined;
    if (!document.hidden) checkRoute();
  });
  window.addEventListener('popstate', checkRoute);
  window.addEventListener('hashchange', checkRoute);
  void chrome.runtime.sendMessage({ type: 'capture.hello' }).then(configure).catch(() => configure({ enabled: false }));
}
