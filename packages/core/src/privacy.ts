export const CONTENT_LIMITS = {
  excerptChars: 3000, fieldChars: 1200, labelChars: 80, summaryChars: 900,
  retentionMs: 24 * 3600000, recordCap: 3000,
  snapshotIntervalMs: 3000, maxDOMNodes: 3000,
};

/** Best-effort deterministic redaction, NOT an anonymity or secret-detection guarantee. */
export function redactContent(value: string, limit: number): { text: string; redactions: number; truncated: boolean } {
  let redactions = 0;
  const mask = (name: string) => () => { redactions++; return `[REDACTED ${name}]`; };
  // Bound work before applying patterns; extra tail prevents persisting an obviously cut-off secret prefix.
  let text = value.slice(0, limit + 512);
  text = text
    .replace(/\b(?:Bearer\s+\S+|(?:sk-|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_\-]{8,})/gi, mask('TOKEN'))
    .replace(/\b(?:password|passwd|api[ _-]?key|access[ _-]?token|secret|cvv|cvc|one[ _-]?time[ _-]?code)\s*[:=]\s*[^\s,;]{1,200}/gi, mask('SECRET'))
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, mask('EMAIL'))
    .replace(/\b(?:https?:\/\/|www\.)[^\s<>"']+/gi, mask('URL'))
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, mask('IDENTIFIER'))
    .replace(/\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,30}\b/g, mask('BANK IDENTIFIER'))
    .replace(/\b(?:\d[ -]?){13,19}\b/g, mask('LONG NUMBER'));
  return { text: text.slice(0, limit), redactions, truncated: value.length > limit || text.length > limit };
}

const STOP = new Set('the and for that this with from your you are was were have has not but can will into then than its our their they when where what which some more less page menu home next back close save edit open search unknown recorded displayed approved field text input content message redacted email url token secret identifier'.split(' '));
/** Local lexical features tolerate changing amounts/IDs. No cloud embeddings or intent claims. */
export function contentTerms(value: string): string[] {
  return [...new Set((value.toLowerCase().match(/[\p{L}]{3,24}/gu) ?? []).filter(t => !STOP.has(t)))].slice(0, 80);
}
export function termSimilarity(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const left = new Set(a), right = new Set(b);
  const common = [...left].filter(t => right.has(t)).length;
  return 2 * common / (left.size + right.size);
}

/** Path (and hash route) with IDs, numbers, emails, and long tokens replaced by :id. No host, query string, or fragment parameters. */
export function routeTemplate(pathname: string, hash = ''): string {
  const template = (path: string) => path.split('/').filter(Boolean).slice(0, 8).map(raw => {
    let s = raw; try { s = decodeURIComponent(raw); } catch { /* keep raw */ }
    if (/^\d+$/.test(s) || /^[0-9a-f-]{8,}$/i.test(s) || /@/.test(s) || s.length > 32 || /\d/.test(s) && s.length >= 6 || /^[A-Za-z0-9_-]{16,}$/.test(s)) return ':id';
    return s.toLowerCase().replace(/[^\p{L}\p{N}._-]/gu, '').slice(0, 32) || ':id';
  }).join('/');
  const path = `/${template(pathname)}`;
  const route = hash.startsWith('#') ? hash.slice(1).split('?')[0] : '';
  return (route && /^\/?[A-Za-z]/.test(route) ? `${path}#${template(route)}` : path).slice(0, 200);
}

/** Local first line of defence for always-on capture, applied before any page is read or any Jev call. Not exhaustive. */
const SENSITIVE_HOST = /(^|\.)(bank|banking|onlinebanking|chase|wellsfargo|citi|citibank|bankofamerica|hsbc|barclays|santander|capitalone|usbank|pnc|ally|schwab|fidelity|vanguard|etrade|robinhood|coinbase|binance|kraken|paypal|venmo|wise|revolut|monzo|irs|ssa|medicare|mychart|kaiserpermanente|healthcare|patient|clinic|hospital|pharmacy|1password|lastpass|bitwarden|dashlane|keepersecurity|okta|auth0|onelogin|adp|gusto|paychex|justworks|pornhub|xvideos|onlyfans)\./i;
const SENSITIVE_SUFFIX = /(\.gov|\.gov\.[a-z]{2}|\.mil|\.bank)$/i;
const SENSITIVE_SUBDOMAIN = /^(login|signin|sso|auth|accounts|id|identity|secure|myaccount|banking)\./i;
export function locallySensitiveHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return SENSITIVE_SUFFIX.test(host) || SENSITIVE_SUBDOMAIN.test(host) || SENSITIVE_HOST.test(`${host}.`);
}

/** Classifies a field value as copied from, derived from, or independent of recently displayed page text. */
export function valueSource(value: string, displays: { id: string; text: string }[]): { source: 'copied' | 'derived' | 'typed'; ref?: string } {
  const v = value.replace(/\s+/g, ' ').trim().toLowerCase();
  if (v.length < 4) return { source: 'typed' };
  const words = [...new Set(v.match(/[\p{L}\p{N}]{4,}/gu) ?? [])];
  let best: { ref: string; share: number } | undefined;
  for (const d of [...displays].reverse()) {
    const text = d.text.replace(/\s+/g, ' ').toLowerCase();
    if (text.includes(v)) return { source: 'copied', ref: d.id };
    const share = words.length ? words.filter(w => text.includes(w)).length / words.length : 0;
    if (!best || share > best.share) best = { ref: d.id, share };
  }
  return best && best.share >= 0.5 ? { source: 'derived', ref: best.ref } : { source: 'typed' };
}
