// Pure calculation logic. Prices are in rupees; maths is done in paise to avoid float errors.
// price === null means "not set" and is different from a valid price of 0.
export function parsePrice(raw) {
  const s = String(raw ?? '').trim();
  if (s === '') return { ok: true, value: null };
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return { ok: false, error: 'Price must be a number of 0 or more, with up to 2 decimals.' };
  return { ok: true, value: Number(s) };
}
export const hasPrice = p => typeof p.price === 'number' && Number.isFinite(p.price) && p.price >= 0;
export const isBillable = p => p.active !== false && hasPrice(p);
const paise = n => Math.round(n * 100);
export const lineTotal = l => paise(l.price) * l.qty / 100;
export const grandTotal = ls => ls.reduce((a, l) => a + paise(l.price) * l.qty, 0) / 100;
const fmt = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 0, maximumFractionDigits: 2 });
export const rupees = n => fmt.format(n);
