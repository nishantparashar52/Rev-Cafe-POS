import * as db from './db.js';
import { parsePrice, hasPrice, isBillable, lineTotal, grandTotal, rupees } from './pricing.js';
import { buildReceipt, esc } from './receipt.js';
import { summarize } from './stats.js';
import { printHtml } from './printing.js';
import { getTodayInventory, bulkSetOpening, bulkSetClosing, setThreshold, parseMaterialsCSV, parseMaterialsJSON } from './inventory.js';
import * as sheets from './sheets.js';

const BIZ = { name: 'REV CAFE', address: 'B 557, Ground Floor, Rajiv Nagar, Mandoli, Delhi – 93', version: '1.0.0' };
const $ = s => document.querySelector(s);
const load = (k, d) => { try { return JSON.parse(localStorage.getItem('revcafe.' + k)) ?? d; } catch { return d; } };
const store = (k, v) => { try { localStorage.setItem('revcafe.' + k, JSON.stringify(v)); } catch {} };
let products = [], materials = [], cart = load('cart', []), tab = 'bill', q = '', cat = '', editingId = null, period = 'today', orders = [];
const byId = id => products.find(p => p.id === Number(id));
const reload = async () => { [products, materials] = await Promise.all([db.getAll(), db.getMaterials()]); };

function show(t) {
  tab = t;
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  $('#bar').hidden = t !== 'bill';
  if (t === 'bill') {
    $('#view').innerHTML = `<section class="panel"><div class="row"><h2>Current Bill</h2><button id="clear">Clear Bill</button></div><div id="lines"></div></section>
    <input id="q" type="search" placeholder="Search products" value="${esc(q)}"><div id="cats" class="chips"></div><div id="grid" class="grid"></div>`;
    updateGrid(); updateCart();
  } else if (t === 'manage') renderManage(); else if (t === 'dash') renderDash(); else if (t === 'inventory') renderInventory(); else renderSettings();
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
  store('cart', cart);
}
function renderManage() {
  const pr = p => hasPrice(p) ? `<span class="pr">${rupees(p.price)}</span>` : '<span class="np">Price Not Set</span>';
  $('#view').innerHTML = `<div class="row"><h2>Manage Products (${products.length})</h2><button class="primary sm" data-act="new">+ Add</button></div>` +
    (products.length ? products.map(p => `<div class="mrow ${p.active === false ? 'off' : ''}"><div><b>${esc(p.name)}</b><small>${[p.code, p.category].filter(Boolean).map(esc).join(' · ')}</small>${pr(p)}${p.active === false ? ' · Inactive' : ''}</div>
    <div class="acts"><button data-act="edit" data-id="${p.id}">Edit</button><button data-act="tog" data-id="${p.id}">${p.active === false ? 'Activate' : 'Deactivate'}</button><button class="danger" data-act="delp" data-id="${p.id}">Delete</button></div></div>`).join('')
      : '<p class="muted">Catalogue is empty.</p>');
}
// ── Inventory state ──────────────────────────────────────────────────────────
let invTab = 'stock';   // 'stock' | 'materials' | 'upload'
let stockMode = 'morning'; // 'morning' | 'evening' | 'thresholds'
let editingMatId = null;

function renderInventory() {
  const tab = (v, label) => `<button class="inv-tab ${invTab === v ? 'on' : ''}" data-act="invtab" data-v="${v}">${label}</button>`;
  const date = new Date().toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const records = getTodayInventory(materials);
  const alerts = records.filter(r => r.status === 'out' || r.status === 'low');
  const alertBadge = alerts.length ? ` <span class="inv-badge">${alerts.length}</span>` : '';

  $('#view').innerHTML = `
    <div class="inv-header"><h2>Inventory</h2><small class="muted">${date}</small></div>
    <div class="inv-tabs">${tab('stock', '☀ Stock')}${tab('materials', '📦 Materials')}${tab('upload', '⬆ Upload')}</div>
    <div id="inv-body"></div>`;

  if (alerts.length) {
    $('#inv-body').insertAdjacentHTML('afterbegin',
      `<div class="inv-alerts"><b>⚠ Stock Alerts (${alerts.length})</b>${alerts.map(r =>
        `<div class="inv-alert-row ${r.status === 'out' ? 'inv-out' : 'inv-low'}">
          <span>${esc(r.material.name)}${r.material.unit ? ` <small>(${esc(r.material.unit)})</small>` : ''}</span>
          <span>${r.status === 'out' ? '🔴 Out of stock' : `🟡 Low — ${r.remaining} left (min: ${r.threshold})`}</span>
        </div>`).join('')}</div>`);
  }

  if (invTab === 'stock') renderInvStock(records);
  else if (invTab === 'materials') renderInvMaterials();
  else renderInvUpload();
}

function renderInvStock(records) {
  if (!records) records = getTodayInventory(materials);
  const modeBtn = (v, label) => `<button class="chip ${stockMode === v ? 'on' : ''}" data-act="stockmode" data-v="${v}">${label}</button>`;
  const colHeader = stockMode === 'morning' ? 'Opening Qty' : stockMode === 'evening' ? 'Closing Qty' : 'Min Threshold';
  const hint = stockMode === 'morning' ? 'Enter stock available at <b>start of day</b> (morning count).'
    : stockMode === 'evening' ? 'Enter stock <b>remaining</b> at end of day.'
    : 'Set minimum quantity that triggers a <b>low stock alert</b>.';

  const summary = records.reduce((a, r) => {
    if (r.open !== null) a.o++; if (r.close !== null) a.c++; return a;
  }, { o: 0, c: 0 });

  if (!materials.length) {
    $('#inv-body').innerHTML += `<p class="muted" style="margin-top:16px">No raw materials yet. Add them under the <b>Materials</b> tab or use <b>Upload</b>.</p>`;
    return;
  }

  const rows = materials.map(m => {
    const r = records.find(x => x.material.id === m.id);
    const val = stockMode === 'morning' ? r.open : stockMode === 'evening' ? r.close : r.threshold;
    const dot = r.status === 'out' ? '<span class="inv-dot inv-dot-out">●</span>'
      : r.status === 'low' ? '<span class="inv-dot inv-dot-low">●</span>'
      : r.status === 'ok' ? '<span class="inv-dot inv-dot-ok">●</span>'
      : '<span class="inv-dot inv-dot-unset">●</span>';
    const meta = stockMode !== 'morning'
      ? `<span class="inv-hint">Open: ${r.open !== null ? r.open : '—'}</span>` : '';
    return `<div class="inv-row">
      <div class="inv-name">${dot}<div><span>${esc(m.name)}</span>${m.unit ? `<small>${esc(m.unit)}${m.category ? ' · ' + esc(m.category) : ''}</small>` : (m.category ? `<small>${esc(m.category)}</small>` : '')}</div></div>
      <div class="inv-meta">${meta}</div>
      <input class="inv-qty" type="number" inputmode="decimal" min="0" step="any" placeholder="—" data-mid="${m.id}" value="${val !== null ? val : ''}">
    </div>`;
  });

  $('#inv-body').innerHTML += `
    <div class="inv-summary-bar">
      <span>Materials: <b>${materials.length}</b></span>
      <span>Opening set: <b>${summary.o}</b></span>
      <span>Closing set: <b>${summary.c}</b></span>
    </div>
    <div class="chips" style="margin:8px 0 4px">${modeBtn('morning', '☀ Morning')}${modeBtn('evening', '🌙 Evening')}${modeBtn('thresholds', '⚡ Thresholds')}</div>
    <div class="inv-mode-hint">${hint}</div>
    <div class="inv-col-head"><span>Raw Material</span><span>${colHeader}</span></div>
    <div id="inv-list">${rows.join('')}</div>
    <div class="inv-actions"><button class="primary" data-act="invsave">Save ${stockMode === 'morning' ? 'Opening Stock' : stockMode === 'evening' ? 'Closing Stock' : 'Thresholds'}</button></div>`;
}

function saveInvStock() {
  const entries = [];
  document.querySelectorAll('.inv-qty[data-mid]').forEach(input => {
    const raw = input.value.trim();
    if (raw === '') return;
    const qty = Number(raw);
    if (!Number.isFinite(qty) || qty < 0) return;
    entries.push({ id: Number(input.dataset.mid), qty });
  });
  if (!entries.length) { alert('No values entered.'); return; }
  if (stockMode === 'morning') bulkSetOpening(entries);
  else if (stockMode === 'evening') bulkSetClosing(entries);
  else entries.forEach(({ id, qty }) => setThreshold(id, qty));
  renderInventory();
  // Push updated inventory to Sheets (fire-and-forget)
  const sheetEntries = entries.map(({ id, qty }) => {
    const m = materials.find(x => x.id === id);
    if (!m) return null;
    const NS = 'revcafe.inv.';
    const today = new Date().toISOString().slice(0, 10);
    const stock = (() => { try { return JSON.parse(localStorage.getItem(`${NS}stock.${today}.${id}`)) ?? {}; } catch { return {}; } })();
    const thr = (() => { try { return JSON.parse(localStorage.getItem(`${NS}threshold.${id}`)); } catch { return null; } })();
    return { materialId: m.id, materialName: m.name, unit: m.unit || '', category: m.category || '', open: stock.open ?? null, close: stock.close ?? null, threshold: thr };
  }).filter(Boolean);
  sheets.pushInventory(sheetEntries);
}

function renderInvMaterials() {
  const cats = [...new Set(materials.map(m => m.category).filter(Boolean))].sort();
  const rows = materials.length
    ? materials.map(m => `<div class="mrow">
        <div><b>${esc(m.name)}</b><small>${[m.unit, m.category].filter(Boolean).map(esc).join(' · ')}</small></div>
        <div class="acts">
          <button data-act="matEdit" data-id="${m.id}">Edit</button>
          <button class="danger" data-act="matDel" data-id="${m.id}">Delete</button>
        </div>
      </div>`).join('')
    : '<p class="muted">No raw materials yet. Add one below or use the Upload tab.</p>';

  $('#inv-body').innerHTML += `
    <div class="row" style="margin-bottom:8px"><h3 style="margin:0">Raw Materials (${materials.length})</h3><button class="primary sm" data-act="matNew">+ Add</button></div>
    ${rows}
    <div style="margin-top:16px"><button data-act="matExport">⬇ Export list (JSON)</button></div>`;
}

function openMaterialForm(m) {
  editingMatId = m?.id ?? null;
  const existing = materials;
  const cats = [...new Set(existing.map(x => x.category).filter(Boolean))];
  $('#mf-name').value = m?.name ?? '';
  $('#mf-unit').value = m?.unit ?? '';
  $('#mf-cat').value = m?.category ?? '';
  $('#mf-thr').value = m?.threshold != null ? m.threshold : '';
  $('#mf-err').textContent = '';
  $('#mf-title').textContent = m ? 'Edit Material' : 'Add Material';
  $('#mf-catlist').innerHTML = cats.map(c => `<option value="${esc(c)}">`).join('');
  $('#matdlg').showModal();
}

async function saveMaterialForm() {
  const name = $('#mf-name').value.trim();
  if (!name) { $('#mf-err').textContent = 'Name is required.'; return; }
  const unit = $('#mf-unit').value.trim();
  const category = $('#mf-cat').value.trim();
  const thrRaw = $('#mf-thr').value.trim();
  let threshold = null;
  if (thrRaw !== '') {
    const t = Number(thrRaw);
    if (!Number.isFinite(t) || t < 0) { $('#mf-err').textContent = 'Threshold must be a positive number.'; return; }
    threshold = t;
  }
  const rec = { name, unit, category, threshold };
  if (editingMatId != null) rec.id = editingMatId;
  try {
    await db.saveMaterial(rec);
    await reload();
    $('#matdlg').close();
    renderInventory();
  } catch { $('#mf-err').textContent = 'Could not save. Please try again.'; }
}

function renderInvUpload() {
  $('#inv-body').innerHTML += `
    <div class="set" style="margin-top:8px">
      <h3 style="margin:0 0 6px">Upload Raw Materials List</h3>
      <p class="muted" style="margin:0 0 10px">Upload a <b>CSV</b> or <b>JSON</b> file to bulk-import or replace your raw materials list.</p>
      <div class="inv-upload-format">
        <b>CSV format</b> (comma-separated, first row = headers):<br>
        <code>name,unit,category,threshold</code><br>
        <code>Potato,kg,Vegetables,2</code><br>
        <code>Mozzarella,kg,Dairy,1</code>
      </div>
      <div class="inv-upload-format" style="margin-top:8px">
        <b>JSON format</b> (array of objects):<br>
        <code>[{"name":"Potato","unit":"kg","category":"Vegetables","threshold":2}]</code>
      </div>
      <div class="acts" style="margin-top:14px;flex-wrap:wrap;gap:8px">
        <button data-act="invUploadAdd" class="primary">⬆ Upload &amp; Add to list</button>
        <button data-act="invUploadReplace">⬆ Upload &amp; Replace list</button>
      </div>
      <input id="inv-file" type="file" accept=".csv,.json,application/json,text/csv" hidden>
      <div id="inv-upload-result" style="margin-top:10px"></div>
    </div>
    <div class="set" style="margin-top:8px">
      <h3 style="margin:0 0 6px">Download Template</h3>
      <div class="acts" style="flex-wrap:wrap;gap:8px">
        <button data-act="invTplCSV">⬇ CSV template</button>
        <button data-act="invTplJSON">⬇ JSON template</button>
      </div>
    </div>`;
}

function renderSettings() {
  const syncStatus = sheets.isOnline()
    ? '<span style="color:#2e7d32">✓ Connected</span>'
    : '<span style="color:#e65100">⚠ Offline / Not configured</span>';
  $('#view').innerHTML = `<div class="set"><h2>${BIZ.name}</h2><p>${BIZ.address}</p><p class="muted">Version ${BIZ.version}</p></div>
  <div class="set"><h2>Printer</h2><p class="muted">Prints a test slip through the iOS print dialog.</p><button data-act="ptest">Print test slip</button></div>
  <div class="set"><h2>Backup</h2><div class="acts"><button data-act="export">Export catalogue</button><button data-act="import">Import catalogue</button></div><input id="file" type="file" accept="application/json" hidden></div>
  <div class="set"><h2>Google Sheets Sync</h2><p class="muted">Status: ${syncStatus}</p><p class="muted">Use this once to migrate existing local data (products, orders, today's inventory) up to Google Sheets.</p><button data-act="pushLocal">⬆ Push local data to Sheets</button></div>`;
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
  try { await db.save(rec); await reload(); sheets.pushProducts(products); $('#dlg').close(); show(tab); } catch { $('#err').textContent = 'Could not save. Please try again.'; }
});
$('#cancel').onclick = () => $('#dlg').close();

async function renderDash() {
  orders = (await db.getOrders()).sort((a, b) => b.at - a.at);
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const list = period === 'today' ? orders.filter(o => o.at >= start.getTime()) : orders;
  const s = summarize(list), none = '<p class="muted">No sales yet.</p>';
  const rowsOf = (obj, f) => Object.entries(obj).sort((a, b) => f(b[1]) - f(a[1]));
  const tr = (l, r) => `<div class="tr"><span>${l}</span><b>${r}</b></div>`;
  const cats = rowsOf(s.cats, v => v).map(([c, v]) => tr(esc(c), rupees(v))).join('');
  const items = rowsOf(s.items, v => v.amount).map(([n, v]) => tr(`${esc(n)} × ${v.qty}`, rupees(v.amount))).join('');
  const olist = list.map(o => `<div class="tr"><span>#${o.id} · ${new Date(o.at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })} · <b>${rupees(o.total)}</b></span><span class="acts"><button class="sm" data-act="omethod" data-id="${o.id}">${o.method === 'cash' ? 'Cash' : 'Online'} ⇄</button><button class="sm danger" data-act="odel" data-id="${o.id}">Delete</button></span></div>`).join('');
  const chip = (v, l) => `<button class="chip ${period === v ? 'on' : ''}" data-act="per" data-v="${v}">${l}</button>`;
  $('#view').innerHTML = `<div class="chips">${chip('today', 'Today')}${chip('all', 'All time')}</div>
  <div class="stats"><div class="stat">Total sales<b>${rupees(s.total)}</b></div><div class="stat">Orders<b>${s.count}</b></div><div class="stat">Cash<b>${rupees(s.cash)}</b></div><div class="stat">Online<b>${rupees(s.online)}</b></div></div>
  <section class="panel"><h2>Sales by category</h2>${cats || none}</section>
  <section class="panel"><h2>Items sold</h2>${items || none}</section>
  <section class="panel"><h2>Orders</h2>${olist || none}</section>`;
}
async function placeOrder(method, shouldPrint) {
  if (!cart.length) return;
  const lines = cart.map(l => ({ ...l }));
  let savedOrder;
  try { savedOrder = { at: Date.now(), method, lines, total: grandTotal(lines) }; await db.saveOrder(savedOrder); }
  catch { alert('Could not save the order. The bill is still open.'); return; }
  sheets.pushOrder(savedOrder);
  $('#od').close(); cart = []; updateCart();
  if (shouldPrint) {
    const no = load('rno', 0) + 1; store('rno', no);
    await printHtml(buildReceipt(lines, { ...BIZ, date: new Date(), no }));
  }
}
document.addEventListener('click', async e => {
  const t = e.target.closest('[data-tab],[data-act],#clear,#order,#ocancel'); if (!t) return;
  if (t.dataset.tab) return show(t.dataset.tab);
  if (t.id === 'order') { if (cart.length) { $('#odt').textContent = 'Total ' + rupees(grandTotal(cart)); $('#od').showModal(); } return; }
  if (t.id === 'ocancel') return $('#od').close();
  if (t.id === 'clear') { if (cart.length && confirm('Clear the current bill?')) { cart = []; updateCart(); } return; }
  const id = Number(t.dataset.id), a = t.dataset.act, line = cart.find(l => l.id === id);
  if (a === 'cat') { cat = t.dataset.v; updateGrid(); }
  else if (a === 'add') { const p = byId(id); if (!p || !isBillable(p)) return; line ? line.qty++ : cart.push({ id, name: p.name, price: p.price, category: p.category || '', qty: 1 }); updateCart(); }
  else if (a === 'inc' && line) { line.qty++; updateCart(); }
  else if (a === 'dec' && line) { if (--line.qty <= 0) cart = cart.filter(l => l.id !== id); updateCart(); }
  else if (a === 'del') { cart = cart.filter(l => l.id !== id); updateCart(); }
  else if (a === 'per') { period = t.dataset.v; renderDash(); }
  else if (a === 'pay') await placeOrder(t.dataset.m, !!t.dataset.print);
  else if (a === 'omethod') { const o = orders.find(x => x.id === id); await db.saveOrder({ ...o, method: o.method === 'cash' ? 'online' : 'cash' }); renderDash(); }
  else if (a === 'odel') { if (confirm('Delete this order? It will be removed from the sales totals.')) { await db.removeOrder(id); renderDash(); } }
  else if (a === 'invtab') { invTab = t.dataset.v; renderInventory(); }
  else if (a === 'stockmode') { stockMode = t.dataset.v; renderInventory(); }
  else if (a === 'invsave') saveInvStock();
  else if (a === 'matNew') openMaterialForm();
  else if (a === 'matEdit') { const m = materials.find(x => x.id === id); if (m) openMaterialForm(m); }
  else if (a === 'matDel') { const m = materials.find(x => x.id === id); if (m && confirm(`Delete "${m.name}"? This cannot be undone.`)) { await db.removeMaterial(id); await reload(); renderInventory(); } }
  else if (a === 'matExport') { const url = URL.createObjectURL(new Blob([JSON.stringify(materials, null, 2)], { type: 'application/json' })); Object.assign(document.createElement('a'), { href: url, download: 'revcafe-materials.json' }).click(); URL.revokeObjectURL(url); }
  else if (a === 'invUploadAdd' || a === 'invUploadReplace') { const fi = $('#inv-file'); fi.dataset.mode = a === 'invUploadReplace' ? 'replace' : 'add'; fi.click(); }
  else if (a === 'invTplCSV') { const csv = 'name,unit,category,threshold\nPotato,kg,Vegetables,2\nTomato,kg,Vegetables,1\nMozzarella,kg,Dairy,1\nPizza Base,pcs,Bakery,5\nOnion,kg,Vegetables,2\nGarlic,kg,Spices,0.5\nWheat Flour,kg,Grains,5\n'; const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); Object.assign(document.createElement('a'), { href: url, download: 'materials-template.csv' }).click(); URL.revokeObjectURL(url); }
  else if (a === 'invTplJSON') { const tpl = [{ name: 'Potato', unit: 'kg', category: 'Vegetables', threshold: 2 }, { name: 'Tomato', unit: 'kg', category: 'Vegetables', threshold: 1 }, { name: 'Mozzarella', unit: 'kg', category: 'Dairy', threshold: 1 }]; const url = URL.createObjectURL(new Blob([JSON.stringify(tpl, null, 2)], { type: 'application/json' })); Object.assign(document.createElement('a'), { href: url, download: 'materials-template.json' }).click(); URL.revokeObjectURL(url); }
  else if (a === 'new') openForm();
  else if (a === 'edit') openForm(byId(id));
  else if (a === 'tog') { const p = byId(id); await db.save({ ...p, active: p.active === false }); await reload(); sheets.pushProducts(products); renderManage(); }
  else if (a === 'delp') { const p = byId(id); if (confirm(`Delete "${p.name}"? This cannot be undone.`)) { await db.remove(id); await reload(); sheets.pushProducts(products); renderManage(); } }
  else if (a === 'pushLocal') {
    const btn = t; btn.disabled = true; btn.textContent = 'Pushing…';
    const allOrders = await db.getOrders();
    const ok = await sheets.pushLocalToSheets(products, allOrders, materials);
    btn.disabled = false; btn.textContent = '⬆ Push local data to Sheets';
    alert(ok ? '✓ All local data pushed to Google Sheets.' : '✗ Push failed. Check that SHEETS_URL is set in sheets.js and the Web App is deployed.');
  }
  else if (a === 'ptest') printHtml(buildReceipt([{ name: 'Test item', price: 10, qty: 1 }], { ...BIZ, date: new Date(), no: 0 }));
  else if (a === 'export') { const url = URL.createObjectURL(new Blob([JSON.stringify(products, null, 2)], { type: 'application/json' })); Object.assign(document.createElement('a'), { href: url, download: 'revcafe-catalogue.json' }).click(); URL.revokeObjectURL(url); }
  else if (a === 'import') $('#file').click();
});
$('#mf-form').addEventListener('submit', async e => { e.preventDefault(); await saveMaterialForm(); });
$('#mf-cancel').onclick = () => $('#matdlg').close();

document.addEventListener('change', async e => {
  if (e.target.id === 'inv-file' && e.target.files[0]) {
    const file = e.target.files[0];
    const mode = e.target.dataset.mode; // 'add' | 'replace'
    const text = await file.text();
    const isCsv = file.name.endsWith('.csv') || file.type === 'text/csv';
    const { rows, errors } = isCsv ? parseMaterialsCSV(text) : parseMaterialsJSON(text);
    if (!rows.length) { alert('No valid materials found.\n' + errors.join('\n')); e.target.value = ''; return; }
    const warn = errors.length ? `\n\nWarnings:\n${errors.join('\n')}` : '';
    const action = mode === 'replace' ? 'Replace' : 'Add';
    if (!confirm(`${action} ${rows.length} material(s)?${warn}`)) { e.target.value = ''; return; }
    try {
      if (mode === 'replace') {
        await db.replaceAllMaterials(rows);
      } else {
        for (const r of rows) await db.saveMaterial(r);
      }
      await reload();
      const result = $('#inv-upload-result');
      if (result) result.innerHTML = `<p style="color:#2e7d32">✓ ${rows.length} material(s) imported successfully.${errors.length ? ` ${errors.length} row(s) skipped.` : ''}</p>`;
      renderInventory();
    } catch { alert('Import failed. Please try again.'); }
    e.target.value = '';
    return;
  }
});

document.addEventListener('input', e => { if (e.target.id === 'q') { q = e.target.value; updateGrid(); } });
document.addEventListener('change', async e => {
  if (e.target.id !== 'file' || !e.target.files[0]) return;
  try {
    const list = JSON.parse(await e.target.files[0].text());
    if (!Array.isArray(list) || list.some(p => typeof p.name !== 'string' || !p.name.trim() || (p.price != null && !parsePrice(p.price).ok))) throw 0;
    if (confirm(`Replace the catalogue with ${list.length} products from this file?`)) { await db.replaceAll(list); await reload(); sheets.pushProducts(products); alert('Catalogue restored.'); }
  } catch { alert('This file is not a valid catalogue backup.'); }
  e.target.value = '';
});
(async () => { await sheets.syncDown(); await reload(); show('bill'); if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js'); })();
