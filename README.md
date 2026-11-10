# REV CAFE POS (offline PWA)

Static app, no build step, no backend. Plain HTML/CSS/ES modules, IndexedDB for the catalogue.
Modules: `pricing.js` (calculations), `db.js` (storage), `receipt.js`, `printing.js` (swap for a native bridge later), `app.js` (UI), `sw.js` (offline cache).

## Run locally
`npx serve .` then open http://localhost:3000 (service workers need HTTPS or localhost).

## Deploy (Vercel)
`npm i -g vercel`, then run `vercel --prod` inside this folder and accept the defaults (framework: Other, no build command, output directory `.`).

## Google Sheets Setup (single source of truth)

All devices share one Google Sheet as the live database. IndexedDB stays as a local cache / offline fallback.

### One-time setup (do this before deploying to staff)

**Step 1 — Create the Google Sheet**
1. Go to [sheets.google.com](https://sheets.google.com) and create a new spreadsheet.
2. Name it `REV CAFE POS`.
3. The Apps Script will create the tabs (`Products`, `Orders`, `Inventory`) automatically on first write.

**Step 2 — Create the Apps Script**
1. Go to [script.google.com](https://script.google.com) → **New project**.
2. Delete the default `myFunction` code.
3. Copy the full contents of `Code.gs` from this repo and paste it in.
4. Click **Services (+ icon)** — no extra services needed; `SpreadsheetApp` is built-in.
5. In the script editor, click **Extensions → Apps Script** (if opening from the Sheet, the script is already bound; otherwise use **Resources → Spreadsheet** to link your Sheet).
   > **Easiest approach:** Open your Sheet → **Extensions → Apps Script** — the script is already bound.

**Step 3 — Bind the script to your Sheet** (if you created the script standalone)
1. In the script editor: **Resources → Spreadsheet** → paste your Sheet URL.

**Step 4 — Deploy as a Web App**
1. Click **Deploy → New deployment**.
2. Type: **Web App**.
3. Execute as: **Me**.
4. Who has access: **Anyone**.
5. Click **Deploy** → copy the **Web App URL** (looks like `https://script.google.com/macros/s/ABC.../exec`).

**Step 5 — Configure the POS**
1. Open `sheets.js` in this repo.
2. Replace `'YOUR_APPS_SCRIPT_URL_HERE'` with your Web App URL:
   ```js
   export const SHEETS_URL = 'https://script.google.com/macros/s/ABC.../exec';
   ```
3. Deploy the POS app (Vercel / any static host).

**Step 6 — Migrate existing local data (first device only)**
1. Open the POS on the device that has existing products/orders.
2. Go to **Settings → Google Sheets Sync → Push local data to Sheets**.
3. All products, orders, and today's inventory are uploaded to the Sheet.
4. All other devices will automatically pull this data on their next load.

### How it works day-to-day

| When | What happens |
|---|---|
| App opens | Fetches latest products, orders, inventory from Sheets → seeds local cache |
| Offline | Falls back to local IndexedDB; shows "⚠ Offline" badge |
| Order placed | Saved locally first, then pushed to Sheets in background |
| Product added/edited/deleted | Sheets catalogue updated immediately |
| Inventory saved (morning/evening) | Today's stock row upserted in Sheets |

### Re-deploying Apps Script after edits
Every time you edit `Code.gs`, you must create a **new deployment** (not update the existing one) for changes to take effect on the `exec` URL. Update `SHEETS_URL` in `sheets.js` if the URL changes.

---

## Install on iPhone / iPad
1. Open the HTTPS URL in Safari while online and wait a few seconds for caching.
2. Share, then Add to Home Screen.
3. Launch from the home screen. Turn on airplane mode and confirm it still opens.

## Releasing updates
Change `V` in `sw.js` (e.g. `revcafe-v2`) on every release, otherwise installed apps keep the old cached files.

## Printing
Uses the iOS print dialog (`window.print`), formatted as two 58mm slips in one job. Direct Bluetooth printing from a PWA is not available on iOS, and compatibility with the Evercom printer is untested. Use Settings, then Print test slip, to check it. If the printer does not appear in the iOS print sheet, you will need the manufacturer's iOS app or a native bridge; only `printing.js` would change.

## Testing checklist
- [ ] Installs on iPhone and iPad; opens in airplane mode
- [ ] Add 60+ products; one with no price shows "Price Not Set" and cannot be added to a bill
- [ ] A product priced 0 is billable; an unset price is not
- [ ] Negative and non-numeric prices are rejected
- [ ] Tap same product twice gives qty 2; +, −, remove, Clear Bill (with confirmation) work
- [ ] Totals match: 2 x 120 + 1 x 80 + 2 x 100 = 520
- [ ] Editing a price does not change a bill already in progress
- [ ] Print 2 COPIES produces two identical slips from one tap; cancelling keeps the bill
- [ ] Catalogue survives closing and reopening; export and import round-trip
- [ ] Evercom printer result recorded here: ______

## Orders and dashboard
Bill tab: Place Order asks for Cash or Online, saves the order to IndexedDB (it survives closing the app), and clears the bill. Online is only a label; no payment gateway is involved.
Dashboard tab: today or all-time sales, cash vs online totals, items sold, sales by category, and an order list where you can switch an order's payment method or delete it. "Today" means since midnight on the device clock.
Extra checks: place cash and online orders and confirm the dashboard totals; reload and confirm they persist; place an order in airplane mode.
