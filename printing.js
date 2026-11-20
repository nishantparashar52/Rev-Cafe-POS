/**
 * printing.js — Thermal printer output for REV CAFE POS
 *
 * Android  → Classic Bluetooth SPP (how the EC-58B actually works)
 *            via capacitor-bluetooth-serial plugin.
 *            The printer must already be paired in Android BT settings.
 *
 * Browser  → window.print() fallback (dev/desktop use).
 *
 * ESC/POS byte commands are used to format the receipt on 58mm paper.
 */

const PAPER_COLS = 32;   // characters across a 58mm roll, standard font

// ── ESC/POS commands ──────────────────────────────────────────────────────────
var ESC = 0x1b;
var GS  = 0x1d;
var LF  = 0x0a;

var CMD = {
  INIT         : [ESC, 0x40],
  ALIGN_CENTER : [ESC, 0x61, 0x01],
  ALIGN_LEFT   : [ESC, 0x61, 0x00],
  BOLD_ON      : [ESC, 0x45, 0x01],
  BOLD_OFF     : [ESC, 0x45, 0x00],
  DOUBLE_HEIGHT: [ESC, 0x21, 0x10],
  NORMAL_SIZE  : [ESC, 0x21, 0x00],
  FEED_3       : [ESC, 0x64, 0x03],
  CUT          : [GS,  0x56, 0x42, 0x00],
};

// ── Binary helpers ────────────────────────────────────────────────────────────
var enc = new TextEncoder();

/**
 * Replace every character above ASCII 127 with a safe printer-friendly
 * equivalent. The EC-58B firmware is CP437/Latin-1 — multi-byte UTF-8
 * sequences (₹, –, smart quotes, etc.) print as garbage bytes.
 */
function sanitise(str) {
  return String(str)
    .replace(/₹/g,  'Rs.')   // Rupee sign  (U+20B9, 3 UTF-8 bytes)
    .replace(/\u2013/g, '-')  // en dash –
    .replace(/\u2014/g, '-')  // em dash —
    .replace(/\u2018/g, "'")  // left single quote '
    .replace(/\u2019/g, "'")  // right single quote '
    .replace(/\u201C/g, '"')  // left double quote "
    .replace(/\u201D/g, '"')  // right double quote "
    .replace(/\u2026/g, '...')// ellipsis …
    .replace(/[^\x00-\x7F]/g, '?'); // catch-all: any remaining non-ASCII → ?
}

function concatBytes() {
  var parts = Array.prototype.slice.call(arguments);
  var arrays = parts.map(function(p) {
    if (Array.isArray(p))        return new Uint8Array(p);
    if (p instanceof Uint8Array) return p;
    if (typeof p === 'number')   return new Uint8Array([p]);
    if (typeof p === 'string')   return enc.encode(sanitise(p));  // sanitise before encode
    return new Uint8Array(0);
  });
  var len = arrays.reduce(function(n, a) { return n + a.length; }, 0);
  var out = new Uint8Array(len);
  var off = 0;
  for (var i = 0; i < arrays.length; i++) { out.set(arrays[i], off); off += arrays[i].length; }
  return out;
}

// ── Text layout ───────────────────────────────────────────────────────────────
function leftRight(left, right) {
  var l = String(left), r = String(right);
  var gap = Math.max(1, PAPER_COLS - l.length - r.length);
  return l + Array(gap + 1).join(' ') + r;
}

function divider() { return Array(PAPER_COLS + 1).join('-'); }

function wrapName(name) {
  var MAX = 20;
  if (name.length <= MAX) return [name];
  var words = name.split(' '), lines = [], cur = '';
  for (var i = 0; i < words.length; i++) {
    var w = words[i];
    var candidate = cur ? cur + ' ' + w : w;
    if (candidate.length <= MAX) { cur = candidate; }
    else { if (cur) lines.push(cur); cur = w.slice(0, MAX); }
  }
  if (cur) lines.push(cur);
  return lines;
}

// ── Build ESC/POS byte payload ────────────────────────────────────────────────
function buildEscPos(lines, merchant) {
  var dateStr = (merchant.date instanceof Date)
    ? merchant.date.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : String(merchant.date);

  // Use plain "Rs." prefix — ₹ is 3-byte UTF-8 and prints as garbage on CP437 printers
  var numFmt = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  var rs  = function(n) { return 'Rs.' + numFmt.format(n); };
  var lt  = function(l) { return Math.round(l.price * 100) * l.qty / 100; };
  var gt  = function(ls) { return ls.reduce(function(a, l) { return a + Math.round(l.price * 100) * l.qty; }, 0) / 100; };

  var parts = [
    CMD.INIT,
    CMD.ALIGN_CENTER, CMD.BOLD_ON, CMD.DOUBLE_HEIGHT,
    merchant.name.toUpperCase(), LF,
    CMD.NORMAL_SIZE, CMD.BOLD_OFF,
    merchant.address, LF,
  ];
  if (merchant.regno) { parts.push(merchant.regno, LF); }
  parts.push(
    dateStr + (merchant.no ? ('  #' + merchant.no) : ''), LF,
    CMD.ALIGN_LEFT,
    divider(), LF
  );

  for (var i = 0; i < lines.length; i++) {
    var l = lines[i];
    var nameLines = wrapName(l.name);
    parts.push(leftRight(nameLines[0], rs(lt(l))), LF);
    for (var j = 1; j < nameLines.length; j++) { parts.push('  ' + nameLines[j], LF); }
    parts.push('  ' + l.qty + ' x ' + rs(l.price), LF);
  }

  parts.push(divider(), LF, CMD.BOLD_ON, leftRight('TOTAL', rs(gt(lines))), LF, CMD.BOLD_OFF, CMD.FEED_3, CMD.CUT);
  return concatBytes.apply(null, parts);
}

// Uint8Array → base64 string (for the plugin's write method)
function toBase64(bytes) {
  var binary = '';
  for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// ── Classic Bluetooth SPP (Android) ──────────────────────────────────────────
// Persist chosen printer MAC across sessions so user picks only once
var PREF_KEY = 'revcafe.printer.address';

function getSavedAddress()  { try { return localStorage.getItem(PREF_KEY) || null; } catch(e) { return null; } }
function saveAddress(addr)  { try { localStorage.setItem(PREF_KEY, addr); } catch(e) {} }
function clearAddress()     { try { localStorage.removeItem(PREF_KEY); } catch(e) {} }

function getBtPlugin() {
  var plugin = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.BluetoothSerial;
  if (!plugin) throw new Error('BluetoothSerial plugin not available.');
  return plugin;
}

async function pickPrinter(BtSerial) {
  var result = await BtSerial.getPairedDevices();
  var devices = result.devices || [];
  if (!devices.length) {
    throw new Error('No paired Bluetooth devices found. Pair the printer in Android Settings > Bluetooth first.');
  }
  var menu = devices.map(function(d, i) { return (i + 1) + '. ' + d.name + ' (' + d.address + ')'; }).join('\n');
  var choice = prompt('Select your printer (enter number):\n\n' + menu);
  if (!choice) throw new Error('cancelled');
  var idx = parseInt(choice, 10) - 1;
  if (idx < 0 || idx >= devices.length) throw new Error('Invalid selection.');
  return devices[idx].address;
}

// Convert ESC/POS Uint8Array to a string the plugin writes as raw bytes via UTF-8
// The plugin does value.getBytes(UTF_8) internally — so we pass ISO-8859-1 chars
// mapped 1:1 from each byte (values 0-255 preserved as Latin-1 codepoints).
function bytesToString(uint8) {
  var out = '';
  for (var i = 0; i < uint8.length; i++) {
    out += String.fromCharCode(uint8[i]);
  }
  return out;
}

async function sppPrint(lines, merchant) {
  var BtSerial = getBtPlugin();
  var payload  = buildEscPos(lines, merchant);
  var raw      = bytesToString(payload);   // raw byte string — NOT base64

  // Use saved address, or prompt once and save it
  var address = getSavedAddress();
  if (!address) {
    address = await pickPrinter(BtSerial);
    saveAddress(address);
  }

  try {
    await BtSerial.connect({ address: address });
    await BtSerial.write({ address: address, value: raw });
  } catch (err) {
    // If connect fails the saved address may be wrong — clear it
    if (err && (err.message || '').toLowerCase().indexOf('connect') !== -1) {
      clearAddress();
    }
    throw err;
  } finally {
    try { await BtSerial.disconnect({ address: address }); } catch (e) { /* ignore */ }
  }
}

// ── Browser HTML print (fallback) ────────────────────────────────────────────
export function printHtml(html) {
  document.getElementById('receipt').innerHTML = html;
  return new Promise(function(resolve) {
    var done = function() { window.removeEventListener('afterprint', done); resolve(); };
    window.addEventListener('afterprint', done);
    window.print();
  });
}

function isCapacitor() {
  return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
}

/**
 * printReceipt — single entry point called by app.js.
 * @param {Array<{name:string, price:number, qty:number}>} lines
 * @param {{name:string, address:string, date:Date, no:number}} merchant
 */
export async function printReceipt(lines, merchant) {
  if (isCapacitor()) {
    try {
      await sppPrint(lines, merchant);
    } catch (err) {
      var msg = err && err.message ? err.message : String(err);
      if (msg === 'cancelled') return;
      alert('Print failed: ' + msg + '\n\nTip: If the wrong printer was selected, go to Settings to reset.');
    }
    return;
  }
  // Browser fallback
  var mod = await import('./receipt.js');
  await printHtml(mod.buildReceipt(lines, merchant));
}
