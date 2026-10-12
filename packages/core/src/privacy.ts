export const CONTENT_LIMITS = {
  excerptChars: 3000, fieldChars: 1200, labelChars: 80, summaryChars: 900,
  retentionMs: 24 * 3600000, recordCap: 1000, sessionMs: 60 * 60000,
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
