/**
 * REV CAFE POS — Google Apps Script Web App
 *
 * Deploy as a Web App:
 *   Execute as: Me
 *   Who has access: Anyone
 *
 * Handles:
 *   GET  ?resource=products|orders|inventory  → returns JSON array
 *   POST body (JSON)                          → writes to Sheet
 *
 * Sheet tabs required: Products, Orders, Inventory
 */

// ── Sheet column definitions ─────────────────────────────────────────────────

var PRODUCTS_HEADERS  = ['id', 'name', 'price', 'code', 'category', 'active'];
var ORDERS_HEADERS    = ['id', 'at', 'method', 'total', 'lines'];
var INVENTORY_HEADERS = ['date', 'materialId', 'materialName', 'unit', 'category', 'open', 'close', 'threshold'];

// ── Entry points ─────────────────────────────────────────────────────────────

function doGet(e) {
  try {
    var resource = (e.parameter.resource || '').toLowerCase();
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheetName = capitalize(resource);
    var sheet = ss.getSheetByName(sheetName);
    if (!sheet) return errorResponse('Unknown resource: ' + resource);
    var data = sheetToJSON(sheet);
    return jsonResponse(data);
  } catch (err) {
    return errorResponse(err.toString());
  }
}

function doPost(e) {
  try {
    var payload = JSON.parse(e.postData.contents);
    var action = payload.action;
    var ss = SpreadsheetApp.getActiveSpreadsheet();

    if (action === 'sync_products') {
      var sheet = getOrCreateSheet(ss, 'Products', PRODUCTS_HEADERS);
      syncProducts(sheet, payload.products);
      return jsonResponse({ ok: true });
    }

    if (action === 'save_order') {
      var sheet = getOrCreateSheet(ss, 'Orders', ORDERS_HEADERS);
      appendOrder(sheet, payload.order);
      return jsonResponse({ ok: true });
    }

    if (action === 'save_inventory') {
      var sheet = getOrCreateSheet(ss, 'Inventory', INVENTORY_HEADERS);
      upsertInventory(sheet, payload.entries);
      return jsonResponse({ ok: true });
    }

    if (action === 'push_local') {
      // One-time migration: push all local data to Sheets
      var pSheet = getOrCreateSheet(ss, 'Products', PRODUCTS_HEADERS);
      var oSheet = getOrCreateSheet(ss, 'Orders', ORDERS_HEADERS);
      var iSheet = getOrCreateSheet(ss, 'Inventory', INVENTORY_HEADERS);
      syncProducts(pSheet, payload.products || []);
      (payload.orders || []).forEach(function(o) { appendOrder(oSheet, o); });
      upsertInventory(iSheet, payload.inventory || []);
      return jsonResponse({ ok: true });
    }

    return errorResponse('Unknown action: ' + action);
  } catch (err) {
    return errorResponse(err.toString());
  }
}

// ── Products ─────────────────────────────────────────────────────────────────

function syncProducts(sheet, products) {
  // Clear data rows (keep header)
  var last = sheet.getLastRow();
  if (last > 1) sheet.deleteRows(2, last - 1);

  if (!products || !products.length) return;

  var rows = products.map(function(p) {
    return [
      p.id       != null ? p.id : '',
      p.name     || '',
      p.price    != null ? p.price : '',
      p.code     || '',
      p.category || '',
      p.active === false ? 'FALSE' : 'TRUE'
    ];
  });
  sheet.getRange(2, 1, rows.length, PRODUCTS_HEADERS.length).setValues(rows);
}

// ── Orders ───────────────────────────────────────────────────────────────────

function appendOrder(sheet, order) {
  sheet.appendRow([
    order.id     != null ? order.id : '',
    order.at     != null ? new Date(order.at).toISOString() : '',
    order.method || '',
    order.total  != null ? order.total : '',
    JSON.stringify(order.lines || [])
  ]);
}

// ── Inventory ────────────────────────────────────────────────────────────────

/**
 * entries: [{ date, materialId, materialName, unit, category, open, close, threshold }]
 * Upsert on (date + materialId): update existing row or append new one.
 */
function upsertInventory(sheet, entries) {
  if (!entries || !entries.length) return;

  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  var dateIdx = headers.indexOf('date');
  var midIdx  = headers.indexOf('materialId');

  entries.forEach(function(entry) {
    var matchRow = -1;
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][dateIdx]) === String(entry.date) &&
          String(data[i][midIdx])  === String(entry.materialId)) {
        matchRow = i + 1; // 1-indexed sheet row
        break;
      }
    }
    var row = [
      entry.date         || '',
      entry.materialId   != null ? entry.materialId : '',
      entry.materialName || '',
      entry.unit         || '',
      entry.category     || '',
      entry.open         != null ? entry.open      : '',
      entry.close        != null ? entry.close     : '',
      entry.threshold    != null ? entry.threshold : ''
    ];
    if (matchRow > 0) {
      sheet.getRange(matchRow, 1, 1, INVENTORY_HEADERS.length).setValues([row]);
    } else {
      sheet.appendRow(row);
    }
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Convert a sheet's rows to an array of plain objects keyed by the header row.
 */
function sheetToJSON(sheet) {
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  var headers = data[0];
  return data.slice(1).map(function(row) {
    var obj = {};
    headers.forEach(function(h, i) {
      obj[h] = row[i] === '' ? null : row[i];
    });
    return obj;
  });
}

/**
 * Get a sheet by name, creating it with headers if it doesn't exist.
 */
function getOrCreateSheet(ss, name, headers) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function errorResponse(msg) {
  return ContentService
    .createTextOutput(JSON.stringify({ ok: false, error: msg }))
    .setMimeType(ContentService.MimeType.JSON);
}
