import { lineTotal, grandTotal, rupees } from './pricing.js';
export const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Builds one receipt string and repeats it, so both copies are identical by construction.
export function buildReceipt(lines, m, copies = 2) {
  const rows = lines.map(l => `<div>${esc(l.name)}</div><div class="r-row"><span>${l.qty} x ${rupees(l.price)}</span><span>${rupees(lineTotal(l))}</span></div>`).join('');
  const one = `<section class="rc"><h1>${esc(m.name)}</h1><p class="c">${esc(m.address)}</p><p class="c">${esc(m.date.toLocaleString('en-IN'))}${m.no ? ' · #' + m.no : ''}</p><hr>${rows}<hr><div class="r-row tot"><span>TOTAL</span><span>${rupees(grandTotal(lines))}</span></div></section>`;
  return one.repeat(copies);
}
