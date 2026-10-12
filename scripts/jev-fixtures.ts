// Synthetic, hand-written evaluation cases for tuning Jev thresholds. No recorded user data.
import type { EpisodeBrief } from '../packages/core/src/jev';

const brief = (apps: string[], actions: string[], content: [string, string][] = [], activeMinutes = 2): EpisodeBrief => ({
  apps, actions, activeMinutes,
  content: content.map(([label, text]) => ({ kind: label === 'Visible page excerpt' ? 'content.display' : 'field.edit', label, text })),
});

export const sites: { hostname: string; title: string; sensitive: boolean }[] = [
  { hostname: 'app.hubspot.com', title: 'Contacts | HubSpot', sensitive: false },
  { hostname: 'acme.zendesk.com', title: 'Ticket #4411 – Zendesk', sensitive: false },
  { hostname: 'mail.google.com', title: 'Inbox (12) - Gmail', sensitive: false },
  { hostname: 'docs.google.com', title: 'Q3 planning - Google Docs', sensitive: false },
  { hostname: 'www.amazon.com', title: 'Amazon.com: Online Shopping', sensitive: false },
  { hostname: 'news.ycombinator.com', title: 'Hacker News', sensitive: false },
  { hostname: 'secure.chase.com', title: 'Chase Online - Accounts', sensitive: true },
  { hostname: 'mychart.example-health.org', title: 'MyChart - Test Results', sensitive: true },
  { hostname: 'www.irs.gov', title: 'Your Online Account | IRS', sensitive: true },
  { hostname: 'vault.bitwarden.com', title: 'Vaults | Bitwarden Web Vault', sensitive: true },
  { hostname: 'workforcenow.adp.com', title: 'ADP Pay Statements', sensitive: true },
  { hostname: 'app.quickbooks.com', title: 'Invoices - QuickBooks', sensitive: false },
];

export const actions: { label: string; role: 'button' | 'link'; expected: string[] }[] = [
  { label: 'Archive conversation', role: 'button', expected: ['delete', 'close'] },
  { label: 'Submit for approval', role: 'button', expected: ['save', 'send'] },
  { label: 'New invoice', role: 'button', expected: ['add'] },
  { label: 'Discard draft', role: 'button', expected: ['cancel', 'delete'] },
  { label: 'View order #8812', role: 'link', expected: ['open'] },
  { label: 'Apply filters', role: 'button', expected: ['search'] },
  { label: 'Continue to shipping', role: 'button', expected: ['next'] },
  { label: '⋯', role: 'button', expected: ['unknown'] },
];

const invoice = (n: string, vendor: string, amount: string, note: string) => brief(['quickbooks'],
  ['quickbooks: page.enter @ /invoices', 'quickbooks: control.activate → open [Invoice ' + n + '] @ /invoices/:id', 'quickbooks: content.display', 'quickbooks: field.edit', 'quickbooks: control.activate → save [Approve invoice]', 'quickbooks: form.submit_attempt'],
  [['Visible page excerpt', `Invoice ${n} from ${vendor}. Amount due ${amount}. Status: awaiting approval. PO matched.`], ['Approval note', note]], 2.2);
const ticket = (n: string, issue: string, reply: string) => brief(['zendesk'],
  ['zendesk: page.enter @ /agent/tickets/:id', 'zendesk: content.display', 'zendesk: control.activate → reply [Public reply]', 'zendesk: field.edit', 'zendesk: control.activate → send [Submit as Solved]'],
  [['Visible page excerpt', `Ticket ${n}: ${issue}`], ['Reply', reply]], 3.1);

export const triage: { name: string; episode: EpisodeBrief; save: boolean }[] = [
  { name: 'invoice approval', episode: invoice('#4821', 'Acme Supplies', '$1,240', 'Approved, matches PO 7781'), save: true },
  { name: 'support ticket reply', episode: ticket('991', 'customer cannot reset password since Monday', 'Hi, I have sent a reset link to your email.'), save: true },
  { name: 'CRM lead update', episode: brief(['hubspot'], ['hubspot: page.enter @ /contacts/:id', 'hubspot: content.display', 'hubspot: control.activate → edit [Edit lifecycle stage]', 'hubspot: field.edit', 'hubspot: control.activate → save [Save]'], [['Visible page excerpt', 'Contact: Dana Lee, Globex. Lifecycle stage: Lead. Last activity: demo call Oct 9.'], ['Lifecycle stage', 'Sales qualified lead']], 1.4), save: true },
  { name: 'expense entry', episode: brief(['expensify'], ['expensify: page.enter @ /reports/:id', 'expensify: control.activate → add [Add expense]', 'expensify: field.edit', 'expensify: field.edit', 'expensify: control.activate → save [Save expense]'], [['Merchant', 'Uber'], ['Amount', '23.40'], ['Category', 'Travel - ground transport']], 1.8), save: true },
  { name: 'reading news', episode: brief(['news.ycombinator.com'], ['news.ycombinator.com: page.enter @ /', 'news.ycombinator.com: control.activate → open', 'news.ycombinator.com: content.display', 'news.ycombinator.com: page.route_change @ /item', 'news.ycombinator.com: content.display'], [['Visible page excerpt', 'Show HN: I built a tiny Lisp in Rust. 312 points, 140 comments.']], 6), save: false },
  { name: 'shopping browse', episode: brief(['amazon.com'], ['amazon.com: page.enter @ /s', 'amazon.com: control.activate → search', 'amazon.com: content.display', 'amazon.com: control.activate → open [Wireless earbuds]', 'amazon.com: content.display'], [['Visible page excerpt', 'Wireless earbuds, noise cancelling, 4.5 stars, $79.99, free delivery Thursday']], 4), save: false },
  { name: 'social scrolling', episode: brief(['x.com'], ['x.com: page.enter @ /home', 'x.com: content.display', 'x.com: control.activate → open', 'x.com: content.display', 'x.com: control.activate → back'], [['Visible page excerpt', 'Trending: #WorldCup. 12K posts. Someone you follow liked a photo.']], 8), save: false },
  { name: 'one-off settings change', episode: brief(['github.com'], ['github.com: page.enter @ /settings/profile', 'github.com: field.edit', 'github.com: control.activate → save [Update profile]'], [['Bio', 'Building things.']], 0.8), save: false },
];

export const boundaries: { name: string; episode: EpisodeBrief; finished: boolean }[] = [
  { name: 'after approve + submit', episode: invoice('#4821', 'Acme Supplies', '$1,240', 'Approved'), finished: true },
  { name: 'after reply sent', episode: ticket('991', 'cannot reset password', 'Reset link sent.'), finished: true },
  { name: 'just opened record', episode: brief(['quickbooks'], ['quickbooks: page.enter @ /invoices', 'quickbooks: control.activate → open [Invoice #4821] @ /invoices/:id'], [['Visible page excerpt', 'Invoice #4821 from Acme Supplies. Amount due $1,240. Status: awaiting approval.']], 0.3), finished: false },
  { name: 'typing a reply', episode: brief(['zendesk'], ['zendesk: page.enter @ /agent/tickets/:id', 'zendesk: control.activate → reply [Public reply]', 'zendesk: field.edit'], [['Reply', 'Hi, thanks for reaching out. Could you']], 1), finished: false },
];

export const matches: { name: string; episode: EpisodeBrief; candidates: EpisodeBrief[]; expected: number | null }[] = [
  { name: 'invoice vs [ticket, invoice]', episode: invoice('#5530', 'Globex', '$310', 'Approved, PO 7790'), candidates: [ticket('991', 'cannot reset password', 'Reset link sent.'), invoice('#4821', 'Acme Supplies', '$1,240', 'Approved')], expected: 1 },
  { name: 'ticket vs [invoice]', episode: ticket('1002', 'billing page shows wrong currency', 'Fixed, please refresh.'), candidates: [invoice('#4821', 'Acme Supplies', '$1,240', 'Approved')], expected: null },
  { name: 'ticket vs [ticket]', episode: ticket('1002', 'billing page shows wrong currency', 'Fixed, please refresh.'), candidates: [ticket('991', 'cannot reset password', 'Reset link sent.')], expected: 0 },
  { name: 'expense vs [CRM, invoice]', episode: triage[3].episode, candidates: [triage[2].episode, triage[0].episode], expected: null },
];

export const relevance: { name: string; label: string; text: string; keep: boolean; outcome?: boolean }[] = [
  { name: 'invoice body', label: 'Visible page excerpt', text: 'Invoice #4821 from Acme Supplies. Amount due $1,240.00. Due Oct 30. 40x paper reams, 12x toner.', keep: true },
  { name: 'nav + cookies', label: 'Visible page excerpt', text: 'Home Products Pricing Blog Careers Contact Accept all cookies Manage preferences © 2026 Acme Inc.', keep: false },
  { name: 'medical note', label: 'Notes', text: 'Patient Jane Doe, DOB 1984-03-02, type 2 diabetes, metformin 500mg twice daily.', keep: false },
  { name: 'success banner (outcome)', label: 'Visible page excerpt', text: 'Invoice #4821 approved. A confirmation has been sent to accounts payable.', keep: true, outcome: true },
  { name: 'validation error (outcome)', label: 'Visible page excerpt', text: 'Could not save: Approval note is required. Please fix the highlighted fields.', keep: true, outcome: false },
];

export const routes: [string, string, string][] = [
  ['/invoices/48213/edit', '', '/invoices/:id/edit'],
  ['/agent/tickets/991', '', '/agent/tickets/:id'],
  ['/mail/u/0/', '#inbox/FMfcgzQXJWbxDLmZqZkdBzqwRKSxVSjD', '/mail/u/:id#inbox/:id'],
  ['/contacts/3f2a9c1e-77aa-4b1e-9e1f-0c2d5e6f7a8b', '', '/contacts/:id'],
  ['/users/jane.doe@example.com/profile', '', '/users/:id/profile'],
];

export const valueSources: { value: string; displays: string[]; expected: 'copied' | 'derived' | 'typed' }[] = [
  { value: 'Acme Supplies', displays: ['Invoice #4821 from Acme Supplies. Amount due $1,240.'], expected: 'copied' },
  { value: 'Approved Acme invoice 4821', displays: ['Invoice #4821 from Acme Supplies. Amount due $1,240.'], expected: 'derived' },
  { value: 'Looks good to me', displays: ['Invoice #4821 from Acme Supplies. Amount due $1,240.'], expected: 'typed' },
];
