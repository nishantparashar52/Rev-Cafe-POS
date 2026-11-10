// Inventory management for raw materials (ingredients).
// Materials master list → IndexedDB 'materials' store (via db.js).
// Daily stock records (opening / closing qty) → localStorage, keyed by date + material id.
// Thresholds are stored per material in localStorage (date-independent standing setting).
//
// Material schema: { id, name, unit, category }
// Daily record:    { open: number|null, close: number|null }
// Threshold:       number|null

const NS = 'revcafe.inv.';

// ── Date helpers ────────────────────────────────────────────────────────────
function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

// ── localStorage key builders ────────────────────────────────────────────────
function stockKey(materialId) {
  return `${NS}stock.${todayKey()}.${materialId}`;
}

function thresholdKey(materialId) {
  return `${NS}threshold.${materialId}`;
}

// ── Low-level read / write ───────────────────────────────────────────────────
function readStock(materialId) {
  try { return JSON.parse(localStorage.getItem(stockKey(materialId))) ?? {}; } catch { return {}; }
}

function writeStock(materialId, patch) {
  const existing = readStock(materialId);
  localStorage.setItem(stockKey(materialId), JSON.stringify({ ...existing, ...patch }));
}

// ── Threshold ────────────────────────────────────────────────────────────────
export function getThreshold(materialId) {
  try { return JSON.parse(localStorage.getItem(thresholdKey(materialId))) ?? null; } catch { return null; }
}

export function setThreshold(materialId, value) {
  localStorage.setItem(thresholdKey(materialId), JSON.stringify(value));
}

// ── Daily stock ──────────────────────────────────────────────────────────────
export function setOpening(materialId, qty) {
  writeStock(materialId, { open: qty });
}

export function setClosing(materialId, qty) {
  writeStock(materialId, { close: qty });
}

export function bulkSetOpening(entries) {
  for (const { id, qty } of entries) setOpening(id, qty);
}

export function bulkSetClosing(entries) {
  for (const { id, qty } of entries) setClosing(id, qty);
}

// ── Enriched daily view ──────────────────────────────────────────────────────
/**
 * Merge today's stock records with the materials master list.
 * Returns array of:
 *   { material, open, close, threshold, remaining, status }
 * where status: 'ok' | 'low' | 'out' | 'unset'
 */
export function getTodayInventory(materials) {
  return materials.map(m => {
    const { open = null, close = null } = readStock(m.id);
    const threshold = getThreshold(m.id);
    const remaining = close !== null ? close : open;
    let status = 'unset';
    if (remaining !== null) {
      if (threshold !== null) {
        status = remaining <= 0 ? 'out' : remaining <= threshold ? 'low' : 'ok';
      } else {
        status = remaining <= 0 ? 'out' : 'ok';
      }
    }
    return { material: m, open, close, threshold, remaining, status };
  });
}

// ── Upload helpers ───────────────────────────────────────────────────────────
/**
 * Parse a CSV string into an array of raw material objects.
 * Expected columns (case-insensitive, comma-separated):
 *   name, unit, category, threshold
 * Only 'name' is required; others are optional.
 * Returns { rows: Array, errors: Array<string> }
 */
export function parseMaterialsCSV(text) {
  const lines = text.trim().split();
  if (lines.length < 2) return { rows: [], errors: ['File must have a header row and at least one data row.'] };
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
  const nameIdx = headers.indexOf('name');
  if (nameIdx === -1) return { rows: [], errors: ['CSV must have a "name" column.'] };
  const unitIdx = headers.indexOf('unit');
  const catIdx = headers.indexOf('category');
  const thrIdx = headers.indexOf('threshold');
  const rows = [], errors = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map(c => c.trim());
    const name = cols[nameIdx] ?? '';
    if (!name) { errors.push(`Row ${i + 1}: missing name, skipped.`); continue; }
    const row = { name };
    if (unitIdx !== -1 && cols[unitIdx]) row.unit = cols[unitIdx];
    if (catIdx !== -1 && cols[catIdx]) row.category = cols[catIdx];
    if (thrIdx !== -1 && cols[thrIdx] !== '' && cols[thrIdx] !== undefined) {
      const t = Number(cols[thrIdx]);
      if (Number.isFinite(t) && t >= 0) row.threshold = t;
    }
    rows.push(row);
  }
  return { rows, errors };
}

/**
 * Validate a JSON array of material objects.
 * Returns { rows: Array, errors: Array<string> }
 */
export function parseMaterialsJSON(text) {
  let list;
  try { list = JSON.parse(text); } catch { return { rows: [], errors: ['Invalid JSON file.'] }; }
  if (!Array.isArray(list)) return { rows: [], errors: ['JSON must be an array of material objects.'] };
  const rows = [], errors = [];
  list.forEach((item, i) => {
    if (typeof item.name !== 'string' || !item.name.trim()) {
      errors.push(`Item ${i + 1}: missing name, skipped.`); return;
    }
    const row = { name: item.name.trim() };
    if (item.unit) row.unit = String(item.unit).trim();
    if (item.category) row.category = String(item.category).trim();
    if (item.threshold != null) {
      const t = Number(item.threshold);
      if (Number.isFinite(t) && t >= 0) row.threshold = t;
    }
    rows.push(row);
  });
  return { rows, errors };
}
