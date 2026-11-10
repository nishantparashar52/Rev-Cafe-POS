import * as db from './db.js';
import { parsePrice, hasPrice, isBillable, lineTotal, grandTotal, rupees } from './pricing.js';
import { buildReceipt, esc } from './receipt.js';
import { printHtml } from './printing.js';

const BIZ = { name: 'REV CAFE', address: 'Rajiv Nagar, Madawali, Delhi – 93', version: '1.0.0' };
const $ = s => document.querySelector(s);
const load = (k, d) => { try { return JSON.parse(localStorage.getItem('revcafe.' + k)) ?? d; } catch { return d; } };
const store = (k, v) => { try { localStorage.setItem('revcafe.' + k, JSON.stringify(v)); } catch {} };
let products = [], cart = load('cart', []), tab = 'bill', q = '', cat = '', editingId = null;
const byId = id => products.find(p => p.id === Number(id));
const reload = async () => { products = await db.getAll(); };

function show(t) {
  tab = t;
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  $('#bar').hidden = t !== 'bill';
  if (t === 'bill') {
    $('#view').innerHTML = `<section class="panel"><div class="row"><h2>Current Bill</h2><button id="clear">Clear Bill</button></div><div id="lines"></div></section>
    <input id="q" type="search" placeholder="Search products" value="${esc(q)}"><div id="cats" class="chips"></div><div id="grid" class="grid"></div>`;
    updateGrid(); updateCart();
  } else if (t === 'manage') renderManage(); else renderSettings();
}
function updateGrid() {
  const term = q.trim().toLowerCase(), act = products.filter(p => p.active !== false);
  const cats = [...new Set(act.map(p => p.category).filter(Boolean))].sort();
  $('#cats').innerHTML = ['All Products', ...cats].map(c => { const v = c === 'All Products' ? '' : c; return `<button class="chip ${cat === v ? 'on' : ''}" data-act="cat" data-v="${esc(v)}">${esc(c)}</button>`; }).join('');
  const list = act.filter(p => (!cat || p.category === cat) && (!term || p.name.toLowerCase().includes(term)));
  $('#grid').innerHTML = list.length ? list.map(p => { const ok = isBillable(p);
    return `<button class="card" data-act="add" data-id="${p.id}" ${ok ? '' : 'disabled'}><span class="n">${esc(p.name)}</span><span class="${ok ? 'pr' : 'np'}">${ok ? rupees(p.price) : 'Price Not Set'}</span>${p.category ? `<small>${esc(p.category)}</small>` : ''}</button>`; }).join('')
    : `<p class="muted">${act.length ? 'No matching products.' : 'No products yet. Add them under Manage.'}</p>`;
}
function updateCart() {
  $('#lines').innerHTML = cart.length ? cart.map(l => `<div class="line"><div><b>${esc(l.name)}</b><small>${rupees(l.price)} each</small></div>
    <div class="qty"><button data-act="dec" data-id="${l.id}">−</button><span>${l.qty}</span><button data-act="inc" data-id="${l.id}">+</button></div>
    <b class="amt">${rupees(lineTotal(l))}</b><button class="x" data-act="del" data-id="${l.id}" aria-label="Remove">✕</button></div>`).join('')
    : '<p class="muted">Tap a product to start a bill.</p>';
  $('#gt').textContent = rupees(grandTotal(cart));
  $('#print').disabled = !cart.length;
  store('cart', cart);
}
function renderManage() {
  const pr = p => hasPrice(p) ? `<span class="pr">${rupees(p.price)}</span>` : '<span class="np">Price Not Set</span>';
  $('#view').innerHTML = `<div class="row"><h2>Manage Products (${products.length})</h2><button class="primary sm" data-act="new">+ Add</button></div>` +
    (products.length ? products.map(p => `<div class="mrow ${p.active === false ? 'off' : ''}"><div><b>${esc(p.name)}</b><small>${[p.code, p.category].filter(Boolean).map(esc).join(' · ')}</small>${pr(p)}${p.active === false ? ' · Inactive' : ''}</div>
    <div class="acts"><button data-act="edit" data-id="${p.id}">Edit</button><button data-act="tog" data-id="${p.id}">${p.active === false ? 'Activate' : 'Deactivate'}</button><button class="danger" data-act="delp" data-id="${p.id}">Delete</button></div></div>`).join('')
      : '<p class="muted">Catalogue is empty.</p>');
}
function renderSettings() {
  $('#view').innerHTML = `<div class="set"><h2>${BIZ.name}</h2><p>${BIZ.address}</p><p class="muted">Version ${BIZ.version}</p></div>
  <div class="set"><h2>Printer</h2><p class="muted">Prints a test slip through the iOS print dialog.</p><button data-act="ptest">Print test slip</button></div>
  <div class="set"><h2>Backup</h2><div class="acts"><button data-act="export">Export catalogue</button><button data-act="import">Import catalogue</button></div><input id="file" type="file" accept="application/json" hidden></div>`;
}
function openForm(p) {
  editingId = p?.id ?? null;
  const f = $('#pf'); $('#dt').textContent = p ? 'Edit product' : 'Add product';
  f.name.value = p?.name ?? ''; f.price.value = hasPrice(p ?? {}) ? p.price : ''; f.code.value = p?.code ?? '';
  f.category.value = p?.category ?? ''; f.active.checked = p ? p.active !== false : true; $('#err').textContent = '';
  $('#cl').innerHTML = [...new Set(products.map(x => x.category).filter(Boolean))].map(c => `<option value="${esc(c)}">`).join('');
  $('#dlg').showModal();
}
$('#pf').addEventListener('submit', async e => {
  e.preventDefault(); const f = e.target, name = f.name.value.trim(), pp = parsePrice(f.price.value);
  if (!name) return $('#err').textContent = 'Product name is required.';
  if (!pp.ok) return $('#err').textContent = pp.error;
  const rec = { name, price: pp.value, code: f.code.value.trim(), category: f.category.value.trim(), active: f.active.checked };
  if (editingId != null) rec.id = editingId;
  try { await db.save(rec); await reload(); $('#dlg').close(); show(tab); } catch { $('#err').textContent = 'Could not save. Please try again.'; }
});
$('#cancel').onclick = () => $('#dlg').close();

async function doPrint() {
  if (!cart.length) return;
  const no = load('rno', 0) + 1; store('rno', no);
  await printHtml(buildReceipt(cart, { ...BIZ, date: new Date(), no }));
}
document.addEventListener('click', async e => {
  const t = e.target.closest('[data-tab],[data-act],#clear,#print'); if (!t) return;
  if (t.dataset.tab) return show(t.dataset.tab);
  if (t.id === 'print') return doPrint();
  if (t.id === 'clear') { if (cart.length && confirm('Clear the current bill?')) { cart = []; updateCart(); } return; }
  const id = Number(t.dataset.id), a = t.dataset.act, line = cart.find(l => l.id === id);
  if (a === 'cat') { cat = t.dataset.v; updateGrid(); }
  else if (a === 'add') { const p = byId(id); if (!p || !isBillable(p)) return; line ? line.qty++ : cart.push({ id, name: p.name, price: p.price, qty: 1 }); updateCart(); }
  else if (a === 'inc' && line) { line.qty++; updateCart(); }
  else if (a === 'dec' && line) { if (--line.qty <= 0) cart = cart.filter(l => l.id !== id); updateCart(); }
  else if (a === 'del') { cart = cart.filter(l => l.id !== id); updateCart(); }
  else if (a === 'new') openForm();
  else if (a === 'edit') openForm(byId(id));
  else if (a === 'tog') { const p = byId(id); await db.save({ ...p, active: p.active === false }); await reload(); renderManage(); }
  else if (a === 'delp') { const p = byId(id); if (confirm(`Delete "${p.name}"? This cannot be undone.`)) { await db.remove(id); await reload(); renderManage(); } }
  else if (a === 'ptest') printHtml(buildReceipt([{ name: 'Test item', price: 10, qty: 1 }], { ...BIZ, date: new Date(), no: 0 }));
  else if (a === 'export') { const url = URL.createObjectURL(new Blob([JSON.stringify(products, null, 2)], { type: 'application/json' })); Object.assign(document.createElement('a'), { href: url, download: 'revcafe-catalogue.json' }).click(); URL.revokeObjectURL(url); }
  else if (a === 'import') $('#file').click();
});
document.addEventListener('input', e => { if (e.target.id === 'q') { q = e.target.value; updateGrid(); } });
document.addEventListener('change', async e => {
  if (e.target.id !== 'file' || !e.target.files[0]) return;
  try {
    const list = JSON.parse(await e.target.files[0].text());
    if (!Array.isArray(list) || list.some(p => typeof p.name !== 'string' || !p.name.trim() || (p.price != null && !parsePrice(p.price).ok))) throw 0;
    if (confirm(`Replace the catalogue with ${list.length} products from this file?`)) { await db.replaceAll(list); await reload(); alert('Catalogue restored.'); }
  } catch { alert('This file is not a valid catalogue backup.'); }
  e.target.value = '';
});
(async () => { await reload(); show('bill'); if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js'); })();
