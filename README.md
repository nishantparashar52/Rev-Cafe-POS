# REV CAFE POS (offline PWA)

Static app, no build step, no backend. Plain HTML/CSS/ES modules, IndexedDB for the catalogue.
Modules: `pricing.js` (calculations), `db.js` (storage), `receipt.js`, `printing.js` (swap for a native bridge later), `app.js` (UI), `sw.js` (offline cache).

## Run locally
`npx serve .` then open http://localhost:3000 (service workers need HTTPS or localhost).

## Deploy (Vercel)
`npm i -g vercel`, then run `vercel --prod` inside this folder and accept the defaults (framework: Other, no build command, output directory `.`).

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
