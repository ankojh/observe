import { CONTENT_LIMITS, redactContent } from '../../../../packages/core/src/privacy';
import type { ContentData } from '../../../../packages/core/src/schemas';

type Session = { id: string; expiresAt: number };
type Field = HTMLInputElement | HTMLTextAreaElement | HTMLElement;
const protectedPurpose = /password|passwd|secret|token|api[ _-]?key|credit|card|cvv|cvc|iban|bank|routing|social.security|\bssn\b|one[ _-]?time|\botp\b|\bpin\b|payment|login|sign[ _-]?in|username/i;
function visible(el: Element): boolean {
  if (document.hidden || !el.isConnected || el.closest('[hidden],[aria-hidden="true"]')) return false;
  const css = getComputedStyle(el);
  if (css.display === 'none' || css.visibility !== 'visible' || Number(css.opacity) === 0) return false;
  return [...el.getClientRects()].some(r => r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth);
}
function labelFor(el: Field): string {
  const raw = el.getAttribute('aria-label') ?? (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.labels?.[0]?.textContent : null) ?? 'Text field';
  return redactContent(raw.trim(), CONTENT_LIMITS.labelChars).text;
}
function supportedField(target: EventTarget | null): { el: Field; type: ContentData['fieldType'] } | null {
  if (!(target instanceof Element)) return null;
  const el = target.closest('input,textarea,[contenteditable]:not([contenteditable="false"]),[role="textbox"]');
  if (!(el instanceof HTMLElement) || !visible(el)) return null;
  const metadata = ['type', 'autocomplete', 'name', 'id', 'aria-label', 'placeholder'].map(a => el.getAttribute(a)?.slice(0, 256) ?? '').join(' ');
  const labels = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.labels?.[0]?.textContent?.slice(0, 256) ?? '' : '';
  // Purpose inspection is transient; metadata, IDs and selectors are never persisted.
  if (protectedPurpose.test(metadata + ' ' + labels)) return null;
  const form = el.closest('form');
  if (form?.querySelector('input[type="password"],input[autocomplete^="cc-"],input[autocomplete="one-time-code"]')) return null;
  if (el instanceof HTMLInputElement) {
    if (el.disabled || el.readOnly || !['text', 'search', 'number'].includes(el.type)) return null;
    return { el, type: el.type as 'text' | 'search' | 'number' };
  }
  if (el instanceof HTMLTextAreaElement) return el.disabled || el.readOnly ? null : { el, type: 'textarea' };
  if (el.isContentEditable && !el.querySelector('input,textarea')) return { el, type: 'contenteditable' };
  return null;
}
function valueOf(el: Field): string { return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : el.innerText; }
function viewportExcerpt(): { text: string; truncated: boolean } {
  const preferred = document.querySelector('main,[role="main"],article');
  const root = preferred && visible(preferred) ? preferred : document.body;
  if (!root) return { text: '', truncated: false };
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const parts: string[] = []; let length = 0, visited = 0, truncated = false;
  const range = document.createRange();
  while (walker.nextNode()) {
    if (++visited > CONTENT_LIMITS.maxDOMNodes) { truncated = true; break; }
    const node = walker.currentNode as Text, parent = node.parentElement;
    if (!parent || parent.closest('script,style,noscript,template,input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],iframe,[hidden],[aria-hidden="true"]') || !visible(parent)) continue;
    range.selectNodeContents(node);
    const rects = [...range.getClientRects()];
    // Only fully viewport-contained text blocks. Do not read offscreen paragraphs or hidden fields.
    if (!rects.length || rects.some(r => r.top < 0 || r.left < 0 || r.bottom > innerHeight || r.right > innerWidth)) continue;
    const text = node.data.slice(0, CONTENT_LIMITS.excerptChars + 512).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    parts.push(text); length += text.length + 1;
    if (length >= CONTENT_LIMITS.excerptChars) { truncated = true; break; }
  }
  return { text: parts.join(' ').slice(0, CONTENT_LIMITS.excerptChars), truncated };
}

export function createContextCapture(send: (data: ContentData, sessionId: string) => Promise<void>) {
  let session: Session | null = null, lastText = '', lastAt = 0;
  let snapshotTimer: ReturnType<typeof setTimeout> | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let observer: MutationObserver | undefined;
  let banner: HTMLElement | undefined;
  const fields = new Map<Field, { before: string | null; dirty: boolean; type: ContentData['fieldType']; timer?: ReturnType<typeof setTimeout>; composing: boolean }>();
  const pending = new Set<Promise<void>>();
  const active = () => !!session && session.expiresAt > Date.now() && !document.hidden;
  function track(data: ContentData) {
    if (!active()) return Promise.resolve();
    const promise = send(data, session!.id).catch(() => {}).finally(() => pending.delete(promise));
    pending.add(promise); return promise;
  }
  function snapshot() {
    if (!active()) return;
    const raw = viewportExcerpt(); const minimized = redactContent(raw.text, CONTENT_LIMITS.excerptChars);
    const text = minimized.text.trim();
    if (!text || text === lastText) return;
    lastText = text; lastAt = Date.now();
    void track({ kind: 'content.display', label: 'Visible page excerpt', text, before: null, after: '', fieldType: 'none', redactions: minimized.redactions, truncated: raw.truncated || minimized.truncated });
  }
  function schedule() {
    if (!active()) return;
    if (snapshotTimer) clearTimeout(snapshotTimer);
    snapshotTimer = setTimeout(snapshot, Math.max(500, CONTENT_LIMITS.snapshotIntervalMs - (Date.now() - lastAt)));
  }
  function flushField(el: Field) {
    const entry = fields.get(el);
    if (!entry || !entry.dirty || entry.composing) return Promise.resolve();
    if (entry.timer) clearTimeout(entry.timer);
    entry.dirty = false;
    const supported = supportedField(el);
    if (!active() || !supported) { fields.delete(el); return Promise.resolve(); }
    const minimized = redactContent(valueOf(el), CONTENT_LIMITS.fieldChars);
    const before = entry.before; entry.before = minimized.text;
    if (before === minimized.text) return Promise.resolve();
    return track({ kind: 'field.edit', label: labelFor(el), text: '', before, after: minimized.text, fieldType: supported.type, redactions: minimized.redactions, truncated: minimized.truncated });
  }
  function stop() {
    session = null; lastText = ''; lastAt = 0;
    if (snapshotTimer) clearTimeout(snapshotTimer);
    if (expiryTimer) clearTimeout(expiryTimer);
    observer?.disconnect(); observer = undefined;
    for (const entry of fields.values()) if (entry.timer) clearTimeout(entry.timer);
    fields.clear(); banner?.remove(); banner = undefined;
  }
  function showBanner() {
    banner = document.createElement('div');
    const shadow = banner.attachShadow({ mode: 'closed' });
    const badge = document.createElement('div');
    badge.textContent = '◉ Observe · CONTENT RECORDING · local / 24h';
    badge.style.cssText = 'position:fixed;top:8px;right:8px;z-index:2147483647;padding:7px 12px;border-radius:7px;background:#176b58;color:white;font:11px system-ui;box-shadow:0 1px 7px #0003;pointer-events:none';
    shadow.append(badge); document.documentElement.append(banner);
  }
  document.addEventListener('focusin', event => {
    if (!active() || !event.isTrusted) return;
    const field = supportedField(event.target); if (!field) return;
    if (!fields.has(field.el)) fields.set(field.el, { before: redactContent(valueOf(field.el), CONTENT_LIMITS.fieldChars).text, dirty: false, type: field.type, composing: false });
    schedule();
  }, true);
  document.addEventListener('input', event => {
    if (!active() || !event.isTrusted) return;
    const field = supportedField(event.target); if (!field) return;
    const entry = fields.get(field.el) ?? { before: null, dirty: false, type: field.type, composing: false };
    entry.dirty = true; entry.composing = event instanceof InputEvent && event.isComposing;
    if (entry.timer) clearTimeout(entry.timer);
    if (!entry.composing) entry.timer = setTimeout(() => { void flushField(field.el); }, 2000);
    fields.set(field.el, entry); schedule();
  }, true);
  document.addEventListener('compositionend', event => {
    if (!active() || !event.isTrusted) return;
    const field = supportedField(event.target); if (!field) return;
    const entry = fields.get(field.el); if (!entry) return;
    entry.composing = false; entry.timer = setTimeout(() => { void flushField(field.el); }, 2000);
  }, true);
  document.addEventListener('focusout', event => { if (event.isTrusted && event.target instanceof HTMLElement) void flushField(event.target); }, true);
  document.addEventListener('submit', event => { if (active() && event.isTrusted) for (const el of fields.keys()) void flushField(el); }, true);
  // Window capture catches ordinary interactions before document-level SPA handlers.
  window.addEventListener('click', event => { if (event.isTrusted) schedule(); }, true);
  window.addEventListener('scroll', schedule, { passive: true, capture: true });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (snapshotTimer) clearTimeout(snapshotTimer);
      for (const entry of fields.values()) if (entry.timer) clearTimeout(entry.timer);
    } else schedule();
  });
  return {
    configure(next: Session | null) {
      if (!next || next.expiresAt <= Date.now()) { stop(); return; }
      if (session?.id === next.id) { session = next; return; }
      stop(); session = next; showBanner();
      observer = new MutationObserver(schedule);
      if (document.body) observer.observe(document.body, { subtree: true, childList: true, characterData: true });
      expiryTimer = setTimeout(stop, Math.max(0, next.expiresAt - Date.now()));
      schedule();
    },
    async flush() {
      if (!active()) return;
      snapshot(); for (const el of fields.keys()) void flushField(el);
      await Promise.all([...pending]);
    },
    boundary() { lastText = ''; for (const el of fields.keys()) if (!fields.get(el)?.dirty) fields.delete(el); },
    route() { fields.forEach(entry => { if (entry.timer) clearTimeout(entry.timer); }); fields.clear(); lastText = ''; schedule(); },
  };
}
