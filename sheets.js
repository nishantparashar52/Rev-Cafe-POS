/**
 * sheets.js — Google Sheets sync layer for REV CAFE POS
 *
 * Google Sheets is the single source of truth for products, orders, and inventory.
 * IndexedDB + localStorage act as the local runtime cache.
 *
 * Usage:
 *   1. Deploy Code.gs as a Google Apps Script Web App.
 *   2. Paste the deployment URL below as SHEETS_URL.
 *   3. Call syncDown() on app load; push helpers are called automatically by app.js.
 */

import * as db from './db.js';

// ── Configuration ─────────────────────────────────────────────────────────────
// Replace this with your deployed Apps Script Web App URL.
export const SHEETS_URL = 'https://script.google.com/macros/s/AKfycbzhpuZ6ojeEFxNqDRqN6b303ub02fhfkkUgWypY5Z7dBvdouW-38ueP0fDgLK2uNPrz/exec';

// ── Sync status ───────────────────────────────────────────────────────────────
let _online = true;

/** Returns true if the last Sheets operation succeeded. */
export function isOnline() { return _online; }

function setOnline(v) {
  _online = v;
  _updateStatusBadge(v);
}

function _updateStatusBadge(online) {
  let badge = document.getElementById('sheets-status');
  if (!badge) {
    badge = document.createElement('div');
    badge.id = 'sheets-status';
    badge.style.cssText = [
      'position:fixed', 'bottom:12px', 'right:12px', 'z-index:9999',
      'font-size:12px', 'padding:4px 10px', 'border-radius:20px',
      'pointer-events:none', 'transition:opacity .4s',
      'font-family:system-ui,sans-serif'
    ].join(';');
    document.body.appendChild(badge);
  }
  if (online) {
    badge.textContent = '✓ Synced';
    badge.style.background = '#e8f5e9';
    badge.style.color = '#2e7d32';
    badge.style.opacity = '1';
    setTimeout(() => { badge.style.opacity = '0'; }, 2500);
  } else {
    badge.textContent = '⚠ Offline — saved locally';
    badge.style.background = '#fff3e0';
    badge.style.color = '#e65100';
    badge.style.opacity = '1';
  }
}

// ── Low-level transport ───────────────────────────────────────────────────────

/**
 * Send a write payload to Apps Script via a GET request with a 'payload' query param.
 *
 * WHY GET instead of POST:
 *   Apps Script Web Apps redirect POST requests, which causes browsers to drop the body.
 *   Additionally, any non-simple Content-Type triggers a CORS preflight that Apps Script
 *   does not handle. Using GET with a URL-encoded payload is a simple request (no preflight,
 *   no redirect body loss) and is the standard workaround for Apps Script from browsers.
 */
async function post(payload) {
  if (!SHEETS_URL || SHEETS_URL === 'YOUR_APPS_SCRIPT_URL_HERE') return null;
  const url = `${SHEETS_URL}?payload=${encodeURIComponent(JSON.stringify(payload))}`;
  const res = await fetch(url);
  return res.json();
}

/** GET a resource (products|orders|inventory) from the Apps Script endpoint. */
async function get(resource) {
  if (!SHEETS_URL || SHEETS_URL === 'YOUR_APPS_SCRIPT_URL_HERE') return null;
  const res = await fetch(`${SHEETS_URL}?resource=${resource}`);
  return res.json();
}

// ── Down-sync (Sheets → local) ────────────────────────────────────────────────

/**
 * Pull products from Sheets → replace IndexedDB catalogue.
 * Returns the fetched array, or null on error.
 */
export async function syncProductsDown() {
  try {
    const rows = await get('products');
    if (!Array.isArray(rows)) return null;
    // Coerce types: price is stored as string/number in Sheets
    const products = rows.map(r => ({
      id:       Number(r.id),
      name:     r.name     || '',
      price:    r.price != null && r.price !== '' ? Number(r.price) : null,
      code:     r.code     || '',
      category: r.category || '',
      active:   r.active === 'FALSE' || r.active === false ? false : true,
    })).filter(p => p.id && p.name);
    await db.replaceAll(products);
    return products;
  } catch {
    return null;
  }
}

/**
 * Pull orders from Sheets → replace IndexedDB orders.
 * Returns the fetched array, or null on error.
 */
export async function syncOrdersDown() {
  try {
    const rows = await get('orders');
    if (!Array.isArray(rows)) return null;
    const orders = rows.map(r => ({
      id:     Number(r.id),
      at:     typeof r.at === 'string' ? new Date(r.at).getTime() : Number(r.at),
      method: r.method || 'cash',
      total:  Number(r.total) || 0,
      lines:  typeof r.lines === 'string' ? JSON.parse(r.lines) : (r.lines || []),
    })).filter(o => o.id && o.at);
    // Replace local orders store
    for (const o of orders) await db.saveOrder(o);
    return orders;
  } catch {
    return null;
  }
}

/**
 * Pull inventory from Sheets → seed today's localStorage stock entries.
 * Only restores today's records (older history stays in Sheets only).
 */
export async function syncInventoryDown() {
  try {
    const rows = await get('inventory');
    if (!Array.isArray(rows)) return null;
    const today = new Date().toISOString().slice(0, 10);
    const NS = 'revcafe.inv.';
    rows
      .filter(r => r.date === today)
      .forEach(r => {
        const key = `${NS}stock.${today}.${r.materialId}`;
        const existing = (() => { try { return JSON.parse(localStorage.getItem(key)) ?? {}; } catch { return {}; } })();
        const merged = { ...existing };
        if (r.open  != null && r.open  !== '') merged.open  = Number(r.open);
        if (r.close != null && r.close !== '') merged.close = Number(r.close);
        localStorage.setItem(key, JSON.stringify(merged));
        if (r.threshold != null && r.threshold !== '') {
          localStorage.setItem(`${NS}threshold.${r.materialId}`, JSON.stringify(Number(r.threshold)));
        }
      });
    return rows;
  } catch {
    return null;
  }
}

/**
 * Full down-sync on app load.
 * Falls back silently to local IndexedDB if offline or URL not configured.
 */
export async function syncDown() {
  if (!SHEETS_URL || SHEETS_URL === 'YOUR_APPS_SCRIPT_URL_HERE') {
    console.warn('[sheets] SHEETS_URL not set — using local IndexedDB only.');
    setOnline(false);
    return;
  }
  try {
    // Fetch all three resources in parallel
    const [p, o, i] = await Promise.all([
      syncProductsDown(),
      syncOrdersDown(),
      syncInventoryDown(),
    ]);
    setOnline(true);
    console.info('[sheets] Synced from Sheets:', { products: p?.length, orders: o?.length });
  } catch (err) {
    setOnline(false);
    console.warn('[sheets] Sync failed — using local cache.', err);
  }
}

// ── Up-sync (local → Sheets) ──────────────────────────────────────────────────

/**
 * Push the full products list to Sheets after any catalogue change.
 * Fire-and-forget — does not block the UI.
 */
export function pushProducts(products) {
  post({ action: 'sync_products', products })
    .then(r => setOnline(!!(r?.ok)))
    .catch(() => setOnline(false));
}

/**
 * Append a single order to Sheets immediately after it is placed.
 * Fire-and-forget.
 */
export function pushOrder(order) {
  post({ action: 'save_order', order })
    .then(r => setOnline(!!(r?.ok)))
    .catch(() => setOnline(false));
}

/**
 * Push today's inventory snapshot to Sheets after saving stock counts.
 * entries: array of { materialId, materialName, unit, category, open, close, threshold }
 * Fire-and-forget.
 */
export function pushInventory(entries) {
  if (!entries || !entries.length) return;
  const date = new Date().toISOString().slice(0, 10);
  const payload = entries.map(e => ({ date, ...e }));
  post({ action: 'save_inventory', entries: payload })
    .then(r => setOnline(!!(r?.ok)))
    .catch(() => setOnline(false));
}

/**
 * One-time migration: push all existing local data to Sheets.
 * Called from the Settings tab "Push local data to Sheets" button.
 */
export async function pushLocalToSheets(products, orders, materials) {
  if (!SHEETS_URL || SHEETS_URL === 'YOUR_APPS_SCRIPT_URL_HERE') {
    alert('Please set the SHEETS_URL in sheets.js first.');
    return false;
  }
  // Build today's inventory entries from materials + localStorage
  const NS = 'revcafe.inv.';
  const today = new Date().toISOString().slice(0, 10);
  const inventory = materials.map(m => {
    const key = `${NS}stock.${today}.${m.id}`;
    const stock = (() => { try { return JSON.parse(localStorage.getItem(key)) ?? {}; } catch { return {}; } })();
    const thr = (() => { try { return JSON.parse(localStorage.getItem(`${NS}threshold.${m.id}`)); } catch { return null; } })();
    return {
      date: today, materialId: m.id, materialName: m.name,
      unit: m.unit || '', category: m.category || '',
      open: stock.open ?? null, close: stock.close ?? null, threshold: thr
    };
  }).filter(e => e.open !== null || e.close !== null || e.threshold !== null);

  try {
    const r = await post({ action: 'push_local', products, orders, inventory });
    setOnline(!!(r?.ok));
    return !!(r?.ok);
  } catch {
    setOnline(false);
    return false;
  }
}
