import { lineTotal } from './pricing.js';
// Pure sales summary over a list of orders: totals, cash/online split, items sold, revenue per category.
export function summarize(orders) {
  const s = { total: 0, count: orders.length, cash: 0, online: 0, items: {}, cats: {} };
  for (const o of orders) {
    s.total += o.total; s[o.method] += o.total;
    for (const l of o.lines) {
      const amt = lineTotal(l), i = s.items[l.name] ??= { qty: 0, amount: 0 };
      i.qty += l.qty; i.amount += amt;
      const c = l.category || 'Uncategorised'; s.cats[c] = (s.cats[c] ?? 0) + amt;
    }
  }
  return s;
}
