import * as db from './db.js';
// db.saveBackup, db.getBackup, db.getAllBackups are used for daily order backups
import { parsePrice, hasPrice, isBillable, lineTotal, grandTotal, rupees } from './pricing.js';
import { esc } from './receipt.js';
import { summarize } from './stats.js';
import { printHtml, printReceipt } from './printing.js';
import { getTodayInventory, bulkSetOpening, bulkSetClosing, setThreshold, parseMaterialsCSV, parseMaterialsJSON } from './inventory.js';
import * as sheets from './sheets.js';

const BIZ = { name: 'REV CAFE', address: 'B 557, Ground Floor, Rajiv Nagar, Mandoli, Delhi - 93', regno: 'FSSAI: 23324007001152', version: '1.0.0' };
const $ = s => document.querySelector(s);
const load = (k, d) => { try { return JSON.parse(localStorage.getItem('revcafe.' + k)) ?? d; } catch { return d; } };
const store = (k, v) => { try { localStorage.setItem('revcafe.' + k, JSON.stringify(v)); } catch {} };
let products = [], materials = [], cart = load('cart', []), tab = 'bill', q = '', cat = '', editingId = null, period = 'today', orders = [];
let pendingOrderId = null; // set when editing a pending order from dashboard; cleared after settling
const byId = id => products.find(p => p.id === Number(id));
const reload = async () => { [products, materials] = await Promise.all([db.getAll(), db.getMaterials()]); };

// ── Daily helpers ──────────────────────────────────────────────────────────────
const todayKey = () => new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'

/** Reset order receipt counter to 0 at the start of each new day. */
function dailyReset() {
  const key = 'rno.date';
  const last = load(key, '');
  const today = todayKey();
  if (last !== today) {
    store('rno', 0);        // reset counter
    store(key, today);      // mark today as reset
  }
}

/** Save today's settled orders as a daily backup to IndexedDB (runs once per day). */
async function dailyBackup() {
  try {
    const today = todayKey();
    const existing = await db.getBackup(today);
    // Always overwrite — captures all of today's orders up to this moment
    const allOrders = await db.getOrders();
    const start = new Date(today).getTime();
    const end = start + 86400000;
    const todayOrders = allOrders.filter(o => o.at >= start && o.at < end);
    if (!todayOrders.length) return;
    await db.saveBackup({
      id: today,
      date: today,
      orders: todayOrders,
      savedAt: Date.now(),
      total: todayOrders.filter(o => o.method !== 'pending').reduce((s, o) => s + o.total, 0),
    });
  } catch (e) { console.warn('[backup] daily backup failed:', e); }
}

/**
 * Download a full backup JSON (products + all orders) to the device.
 * This file CAN survive a fresh install — user keeps it in Files / WhatsApp.
 */
async function downloadFullBackup() {
  const allOrders = await db.getOrders();
  const backup = {
    version: 1,
    exportedAt: new Date().toISOString(),
    date: todayKey(),
    products,
    orders: allOrders,
  };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  Object.assign(document.createElement('a'), {
    href: url,
    download: `revcafe-backup-${todayKey()}.json`,
  }).click();
  URL.revokeObjectURL(url);
  showToast('✓ Backup downloaded');
}

/**
 * Restore products + orders from a backup JSON file.
 * Called on first launch or manually from Dashboard.
 */
async function restoreFromBackup(file) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!data.version || !Array.isArray(data.products) || !Array.isArray(data.orders)) {
      throw new Error('Invalid backup file format.');
    }
    if (data.products.length) await db.replaceAll(data.products);
    for (const o of data.orders) await db.saveOrder(o);
    await reload();
    return { products: data.products.length, orders: data.orders.length };
  } catch (e) {
    throw new Error('Could not restore: ' + (e.message || e));
  }
}

/** Show a brief floating toast message anchored to the footer. */
function showToast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  // Trigger animation after paint
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('toast-show')));
  setTimeout(() => { el.classList.remove('toast-show'); setTimeout(() => el.remove(), 300); }, 1200);
}

function show(t) {
  tab = t;
  const moreTabs = ['inventory', 'manage', 'settings'];
  document.querySelectorAll('nav button[data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  document.querySelectorAll('.more-menu button[data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  const moreBtn = $('#morebtn');
  if (moreBtn) {
    moreBtn.classList.toggle('on', moreTabs.includes(t));
    moreBtn.classList.remove('open');
  }
  const menu = $('#moremenu');
  if (menu) menu.classList.remove('open');
  $('#bar').hidden = t !== 'bill';
  if (t === 'bill') {
    $('#view').innerHTML = `<section class="panel bill-panel"><div class="row"><h2 id="bill-h2">Current Bill</h2><button id="clear" class="sm ghost">Clear</button></div><div id="lines"></div></section>
    <div class="search-bar-wrap"><input id="q" type="search" placeholder="🔍 Search menu…" autocomplete="off" value="${esc(q)}"><div id="cats" class="chips"></div></div><div id="grid" class="grid"></div>`;
    updateGrid(); updateCart();
  } else if (t === 'manage') renderManage(); else if (t === 'dash') renderDash(); else if (t === 'inventory') renderInventory(); else renderSettings();
}
function updateGrid() {
  const term = q.trim().toLowerCase(), act = products.filter(p => p.active !== false);
  const cats = [...new Set(act.map(p => p.category).filter(Boolean))].sort();
  $('#cats').innerHTML = ['All Products', ...cats].map(c => { const v = c === 'All Products' ? '' : c; return `<button class="chip ${cat === v ? 'on' : ''}" data-act="cat" data-v="${esc(v)}">${esc(c)}</button>`; }).join('');
  // When searching, ignore category filter so results come from the full catalogue
  const list = act.filter(p => (!term ? (!cat || p.category === cat) : p.name.toLowerCase().includes(term)));
  $('#grid').innerHTML = list.length ? list.map(p => { const ok = isBillable(p);
    return `<button class="card" data-act="add" data-id="${p.id}" ${ok ? '' : 'disabled'}><span class="n">${esc(p.name)}</span><span class="${ok ? 'pr' : 'np'}">${ok ? rupees(p.price) : 'Price Not Set'}</span>${p.category ? `<small>${esc(p.category)}</small>` : ''}</button>`; }).join('')
    : `<p class="muted">${act.length ? 'No matching products.' : 'No products yet. Add them under Manage.'}</p>`;
}
function updateCart() {
  const totalItems = cart.reduce((n, l) => n + l.qty, 0);
  const h2 = $('#bill-h2');
  if (h2 && !h2.dataset.pending) {
    h2.innerHTML = totalItems ? `Current Bill <span class="cart-badge">${totalItems}</span>` : 'Current Bill';
  }
  $('#lines').innerHTML = cart.length ? cart.map(l => `<div class="line"><div><b>${esc(l.name)}</b><small>${rupees(l.price)} each</small></div>
    <div class="qty"><button data-act="dec" data-id="${l.id}">−</button><span>${l.qty}</span><button data-act="inc" data-id="${l.id}">+</button></div>
    <b class="amt">${rupees(lineTotal(l))}</b><button class="x" data-act="del" data-id="${l.id}" aria-label="Remove">✕</button></div>`).join('')
    : '<p class="muted">Tap a product to start a bill.</p>';
  $('#gt').textContent = rupees(grandTotal(cart));
  store('cart', cart);
}
function parseProductsCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return { rows: [], errors: ['File must have a header row and at least one data row.'] };
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
  const nameIdx  = headers.indexOf('name');
  const priceIdx = ['price', 'selling price', 'selling_price', 'rate', 'mrp'].reduce((found, alias) => found !== -1 ? found : headers.indexOf(alias), -1);
  const catIdx   = ['category', 'cat', 'type'].reduce((found, alias) => found !== -1 ? found : headers.indexOf(alias), -1);
  const codeIdx  = ['code', 'sku', 'item code', 'product code', 'item no', 'item number'].reduce((found, alias) => found !== -1 ? found : headers.indexOf(alias), -1);
  const actIdx   = ['active', 'enabled', 'available'].reduce((found, alias) => found !== -1 ? found : headers.indexOf(alias), -1);
  if (nameIdx === -1) return { rows: [], errors: ['CSV must have a "name" column.'] };
  const rows = [], errors = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map(c => c.trim());
    const name = cols[nameIdx] || '';
    if (!name) { errors.push(`Row ${i + 1}: skipped — name is empty.`); continue; }
    let price = null;
    if (priceIdx !== -1 && cols[priceIdx]) {
      const pp = parsePrice(cols[priceIdx]);
      if (!pp.ok) { errors.push(`Row ${i + 1} (${name}): invalid price — ${pp.error}`); continue; }
      price = pp.value;
    }
    rows.push({
      name,
      price,
      category: catIdx !== -1 ? (cols[catIdx] || '') : '',
      code:     codeIdx !== -1 ? (cols[codeIdx] || '') : '',
      active:   actIdx  !== -1 ? cols[actIdx] !== 'false' && cols[actIdx] !== 'FALSE' : true,
    });
  }
  return { rows, errors };
}

function renderManage() {
  const pr = p => hasPrice(p) ? `<span class="pr">${rupees(p.price)}</span>` : '<span class="np">Price Not Set</span>';
  $('#view').innerHTML =
    `<div class="row"><h2>Manage Products (${products.length})</h2><button class="primary sm" data-act="new">+ Add</button></div>
    <div class="acts" style="margin:8px 0;flex-wrap:wrap;gap:8px">
      <button class="sm" data-act="prodUploadAdd">⬆ Upload &amp; Add</button>
      <button class="sm" data-act="prodUploadReplace">⬆ Upload &amp; Replace</button>
      <button class="sm" data-act="prodTplCSV">⬇ CSV Template</button>
    </div>
    <input id="prod-file" type="file" accept=".csv,text/csv" hidden>` +
    (products.length ? products.map(p => `<div class="mrow ${p.active === false ? 'off' : ''}"><div><b>${esc(p.name)}</b><small>${[p.code, p.category].filter(Boolean).map(esc).join(' · ')}</small>${pr(p)}${p.active === false ? ' · Inactive' : ''}</div>
    <div class="acts"><button data-act="edit" data-id="${p.id}">Edit</button><button data-act="tog" data-id="${p.id}">${p.active === false ? 'Activate' : 'Deactivate'}</button><button class="danger" data-act="delp" data-id="${p.id}">Delete</button></div></div>`).join('')
      : '<p class="muted">Catalogue is empty. Upload a CSV or tap + Add.</p>');
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

async function renderSettings() {
  const syncStatus = sheets.isOnline()
    ? '<span style="color:#2e7d32">✓ Connected</span>'
    : '<span style="color:#e65100">⚠ Offline / Not configured</span>';
  const savedPrinter = localStorage.getItem('revcafe.printer.address');
  const printerInfo = savedPrinter
    ? `<p class="muted">Paired printer: <b>${savedPrinter}</b></p><div class="acts"><button data-act="ptest">Print test slip</button><button data-act="preset">Reset printer</button></div>`
    : `<p class="muted">No printer selected yet. Tap "Print test slip" to pick one.</p><button data-act="ptest">Print test slip</button>`;
  // Load backups for display
  const backups = (await db.getAllBackups()).sort((a, b) => b.date.localeCompare(a.date));
  const backupRows = backups.length
    ? backups.map(b => `<div class="tr"><span><b>${b.date}</b> · ${b.orders.length} orders · ${rupees(b.total)}</span><button class="sm" data-act="dlBackup" data-id="${esc(b.date)}">⬇ Download</button></div>`).join('')
    : '<p class="muted">No backups yet. Backups are created automatically when orders are placed.</p>';
  $('#view').innerHTML = `<div class="set"><h2>${BIZ.name}</h2><p>${BIZ.address}</p><p class="muted">${BIZ.regno}</p><p class="muted">Version ${BIZ.version}</p></div>
  <div class="set"><h2>Printer</h2>${printerInfo}</div>
  <div class="set"><h2>Catalogue Backup</h2><div class="acts"><button data-act="export">Export catalogue</button><button data-act="import">Import catalogue</button></div><input id="file" type="file" accept="application/json" hidden></div>
  <div class="set"><h2>Daily Order Backups</h2><p class="muted">Saved automatically each day when orders are placed. Download any day's orders as JSON.</p>${backupRows}</div>
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
  const olist = list.map(o => {
    const isPending = o.method === 'pending';
    const timeStr = new Date(o.at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    const methodBadge = isPending
      ? `<span class="badge-pending">PENDING</span>`
      : `<button class="sm" data-act="omethod" data-id="${o.id}">${o.method === 'cash' ? 'Cash' : 'Online'} ⇄</button>`;
    const totalStr = isPending ? '' : ` · <b>${rupees(o.total)}</b>`;
    const itemCount = o.lines ? o.lines.reduce((n, l) => n + l.qty, 0) : 0;
    const editBtn = isPending ? `<button class="sm" data-act="oedit" data-id="${o.id}">Edit</button>` : '';
    // Inline items breakdown
    const itemRows = (o.lines || []).map(l =>
      `<div class="oitem-row">
        <span class="oitem-name">${esc(l.name)}</span>
        <span class="oitem-qty">×${l.qty}</span>
        <span class="oitem-price">${rupees(l.price)}</span>
        <span class="oitem-total">${rupees(Math.round(l.price * 100) * l.qty / 100)}</span>
      </div>`
    ).join('');
    const itemsPanel = `<div class="oitems-panel" id="oitems-${o.id}" hidden>
      <div class="oitem-head"><span>Item</span><span>Qty</span><span>Rate</span><span>Amount</span></div>
      ${itemRows}
      ${isPending ? '' : `<div class="oitem-total-row"><span>Total</span><span></span><span></span><b>${rupees(o.total)}</b></div>`}
    </div>`;
    return `<div class="orow" id="orow-${o.id}">
      <div class="tr orow-header" data-act="otoggle" data-id="${o.id}" style="cursor:pointer">
        <span class="orow-info">
          <span class="orow-chevron" id="ochev-${o.id}">▶</span>
          <b>#${o.id}</b> · ${timeStr}${totalStr}
          ${methodBadge}
          ${isPending ? `<small style="color:var(--text-3)">${itemCount} item${itemCount !== 1 ? 's' : ''}</small>` : ''}
        </span>
        <span class="acts" onclick="event.stopPropagation()">
          ${editBtn}
          <button class="sm danger" data-act="odel" data-id="${o.id}">Delete</button>
        </span>
      </div>
      ${itemsPanel}
    </div>`;
  }).join('');
  const chip = (v, l) => `<button class="chip ${period === v ? 'on' : ''}" data-act="per" data-v="${v}">${l}</button>`;

  // Show restore banner if no orders at all (fresh install)
  const restoreBanner = orders.length === 0
    ? `<div class="restore-banner">
        <div>
          <b>Fresh install?</b>
          <span>Restore your data from a previous backup file.</span>
        </div>
        <button class="sm primary" data-act="restoreBackup">⬆ Restore</button>
        <input id="restore-file" type="file" accept="application/json" hidden>
      </div>`
    : '';

  $('#view').innerHTML = `
  ${restoreBanner}
  <div class="dash-header">
    <div class="chips" style="flex:1">${chip('today', 'Today')}${chip('all', 'All time')}</div>
    <button class="sm backup-btn" data-act="dlBackupFull">⬇ Backup</button>
  </div>
  <div class="stats"><div class="stat">Total sales<b>${rupees(s.total)}</b></div><div class="stat">Settled<b>${s.count}</b></div><div class="stat">Cash<b>${rupees(s.cash)}</b></div><div class="stat">Online<b>${rupees(s.online)}</b></div>${s.pending ? `<div class="stat">Pending<b style="color:#ff9800">${s.pending}</b></div>` : ''}</div>
  <section class="panel"><h2>Sales by category</h2>${cats || none}</section>
  <section class="panel"><h2>Items sold</h2>${items || none}</section>
  <section class="panel"><h2>Orders</h2>${olist || none}</section>`;
}
async function placeOrder(method, shouldPrint) {
  if (!cart.length) return;
  const lines = cart.map(l => ({ ...l }));
  let savedOrder;
  try {
    if (pendingOrderId) {
      // Editing an existing pending order — update in place, preserve original id + timestamp
      const existing = orders.find(o => o.id === pendingOrderId);
      savedOrder = { ...existing, method, lines, total: grandTotal(lines) };
    } else {
      savedOrder = { at: Date.now(), method, lines, total: grandTotal(lines) };
    }
    await db.saveOrder(savedOrder);
  } catch { alert('Could not save the order. The bill is still open.'); return; }
  sheets.pushOrder(savedOrder);
  const wasEditing = pendingOrderId;
  pendingOrderId = null;
  $('#od').close(); cart = []; store('cart', []); updateCart();
  // Update bill header back to normal
  const h2 = document.querySelector('#view h2');
  if (h2 && h2.dataset.pending) { h2.textContent = 'Current Bill'; delete h2.dataset.pending; }
  // Run backup after every settled order (non-pending)
  if (method !== 'pending') dailyBackup();
  if (shouldPrint && method !== 'pending') {
    const no = load('rno', 0) + 1; store('rno', no);
    await printReceipt(lines, { ...BIZ, date: new Date(), no });
  }
}
document.addEventListener('click', async e => {
  const t = e.target.closest('[data-tab],[data-act],#clear,#order,#ocancel'); if (!t) return;
  if (t.dataset.tab) return show(t.dataset.tab);
  if (t.id === 'order') {
    if (cart.length) {
      $('#odt').textContent = pendingOrderId ? `Order #${pendingOrderId} · ${rupees(grandTotal(cart))}` : 'Total ' + rupees(grandTotal(cart));
      $('#odt-title').textContent = pendingOrderId ? 'Settle pending order' : 'Payment received by';
      $('#od').showModal();
    }
    return;
  }
  if (t.id === 'ocancel') return $('#od').close();
  if (t.id === 'clear') { if (cart.length && confirm('Clear the current bill?')) { cart = []; pendingOrderId = null; store('cart', []); updateCart(); } return; }
  const id = Number(t.dataset.id), a = t.dataset.act, line = cart.find(l => l.id === id);
  if (a === 'cat') { cat = t.dataset.v; updateGrid(); }
  else if (a === 'add') {
    const p = byId(id); if (!p || !isBillable(p)) return;
    if (line) { line.qty++; } else { cart.push({ id, name: p.name, price: p.price, category: p.category || '', qty: 1 }); }
    updateCart();
    showToast(`+ ${p.name}`);
  }
  else if (a === 'inc' && line) { line.qty++; updateCart(); }
  else if (a === 'dec' && line) { if (--line.qty <= 0) cart = cart.filter(l => l.id !== id); updateCart(); }
  else if (a === 'del') { cart = cart.filter(l => l.id !== id); updateCart(); }
  else if (a === 'per') { period = t.dataset.v; renderDash(); }
  else if (a === 'otoggle') {
    const panel = document.getElementById(`oitems-${id}`);
    const chev  = document.getElementById(`ochev-${id}`);
    if (!panel) return;
    const expanded = !panel.hidden;
    panel.hidden = expanded;
    if (chev) chev.textContent = expanded ? '▶' : '▼';
  }
  else if (a === 'dlBackupFull') { await downloadFullBackup(); }
  else if (a === 'restoreBackup') { $('#restore-file')?.click(); }
  else if (a === 'pay') await placeOrder(t.dataset.m, !!t.dataset.print);
  else if (a === 'omethod') { const o = orders.find(x => x.id === id); await db.saveOrder({ ...o, method: o.method === 'cash' ? 'online' : 'cash' }); renderDash(); }
  else if (a === 'odel') { if (confirm('Delete this order? It will be removed from the sales totals.')) { await db.removeOrder(id); if (pendingOrderId === id) { pendingOrderId = null; cart = []; store('cart', []); } renderDash(); } }
  else if (a === 'oedit') {
    const o = orders.find(x => x.id === id);
    if (!o) return;
    pendingOrderId = o.id;
    cart = o.lines.map(l => ({ ...l }));
    store('cart', cart);
    show('bill');
    // Mark the bill header so staff know they are editing a pending order
    const h2 = $('#view h2');
    if (h2) { h2.innerHTML = `Editing Pending <span style="color:#ff9800">#${o.id}</span>`; h2.dataset.pending = '1'; }
  }
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
  else if (a === 'prodUploadAdd' || a === 'prodUploadReplace') { const fi = $('#prod-file'); fi.dataset.mode = a === 'prodUploadReplace' ? 'replace' : 'add'; fi.click(); }
  else if (a === 'prodTplCSV') { const csv = 'name,price,category,code,active\nMalai Chaap,110,Starters,,true\nPaneer Tikka,180,Starters,,true\nCold Coffee,80,Beverages,CC,true\nMasala Chai,30,Beverages,MC,true\n'; const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); Object.assign(document.createElement('a'), { href: url, download: 'products-template.csv' }).click(); URL.revokeObjectURL(url); }
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
  else if (a === 'ptest') printReceipt([{ name: 'Test item', price: 10, qty: 1 }], { ...BIZ, date: new Date(), no: 0 });
  else if (a === 'preset') { localStorage.removeItem('revcafe.printer.address'); renderSettings(); }
  else if (a === 'dlBackup') {
    const backup = await db.getBackup(t.dataset.id);
    if (!backup) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
    Object.assign(document.createElement('a'), { href: url, download: `revcafe-orders-${backup.date}.json` }).click();
    URL.revokeObjectURL(url);
  }
  else if (a === 'export') { const url = URL.createObjectURL(new Blob([JSON.stringify(products, null, 2)], { type: 'application/json' })); Object.assign(document.createElement('a'), { href: url, download: 'revcafe-catalogue.json' }).click(); URL.revokeObjectURL(url); }
  else if (a === 'import') $('#file').click();
});
$('#mf-form').addEventListener('submit', async e => { e.preventDefault(); await saveMaterialForm(); });
$('#mf-cancel').onclick = () => $('#matdlg').close();

document.addEventListener('change', async e => {
  if (e.target.id === 'prod-file' && e.target.files[0]) {
    const file = e.target.files[0];
    const mode = e.target.dataset.mode;
    const text = await file.text();
    const { rows, errors } = parseProductsCSV(text);
    if (!rows.length) { alert('No valid products found.\n' + errors.join('\n')); e.target.value = ''; return; }
    const warn = errors.length ? `\n\nWarnings:\n${errors.join('\n')}` : '';
    const action = mode === 'replace' ? 'Replace entire catalogue' : 'Add';
    if (!confirm(`${action} with ${rows.length} product(s)?${warn}`)) { e.target.value = ''; return; }
    try {
      if (mode === 'replace') {
        await db.replaceAll(rows);
      } else {
        for (const r of rows) await db.save(r);
      }
      await reload();
      sheets.pushProducts(products);
      renderManage();
      alert(`✓ ${rows.length} product(s) imported.${errors.length ? ` ${errors.length} row(s) skipped.` : ''}`);
    } catch { alert('Import failed. Please try again.'); }
    e.target.value = '';
    return;
  }
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

// ── More dropdown ─────────────────────────────────────────────────────────────
document.getElementById('morebtn').addEventListener('click', e => {
  e.stopPropagation();
  const menu = $('#moremenu');
  const btn  = $('#morebtn');
  const isOpen = menu.classList.toggle('open');
  btn.classList.toggle('open', isOpen);
});
document.addEventListener('click', e => {
  if (!e.target.closest('.more-wrap')) {
    $('#moremenu')?.classList.remove('open');
    $('#morebtn')?.classList.remove('open');
  }
});

document.addEventListener('change', async e => {
  if (e.target.id !== 'restore-file' || !e.target.files[0]) return;
  const file = e.target.files[0];
  if (!confirm('Restore products and orders from this backup? Existing data will be replaced.')) { e.target.value = ''; return; }
  try {
    const result = await restoreFromBackup(file);
    alert(`✓ Restored: ${result.products} products, ${result.orders} orders.`);
    show('dash');
  } catch (err) {
    alert(err.message);
  }
  e.target.value = '';
});

document.addEventListener('focus', e => {
  if (e.target.id === 'q') window.scrollTo({ top: 0, behavior: 'smooth' });
}, true);
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
(async () => {
  try { dailyReset(); } catch (e) { console.warn('[init] dailyReset failed:', e); }
  try { await sheets.syncDown(); } catch (e) { console.warn('[init] syncDown failed:', e); }
  try { await reload(); } catch (e) { console.warn('[init] reload failed:', e); }
  try { show('bill'); } catch (e) { console.error('[init] show failed:', e); alert('App failed to start: ' + e.message); }
  try { await dailyBackup(); } catch (e) { console.warn('[init] dailyBackup failed:', e); }
  // Service workers are not supported in Capacitor's WKWebView (iOS) or Android WebView.
  const inCapacitor = !!(window.Capacitor?.isNativePlatform?.());
  if (!inCapacitor && 'serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
})();
