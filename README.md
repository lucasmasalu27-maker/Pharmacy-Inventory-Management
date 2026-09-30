# Pharmacy-Inventory-Management
Stock inventory control, Management and tracing

**Pharmacy Ledger & Dispensing Register** – one app for the pharmacist in charge to control and trace every item from the moment it arrives from MSD or a vendor to the patient who receives it.

It runs on **Android** (phone/tablet) and **Linux desktop**, works **offline**, and several devices can work as **one system** through a small office server on the Linux PC.

## The two models, linked

| | **Ledger** (stock control) | **Dispensing Register** (patients) |
|---|---|---|
| Records | Goods received (GRN), issues to wards/units, returns, expiry & damage write-offs, corrections | Every prescription: serial no, date, patient ID / file no, items, dosage, batch, dispenser |
| View | Stock card (bin card) per item with running balance | Register by date range; controlled-medicines register |
| Rules | Append-only: entries are never edited or deleted, only reversed | Voided entries stay visible, struck through, with reason and who voided them |

**The link:** both share one batch-level stock database. Saving a register entry posts `DISPENSE` lines to the ledger automatically, picking batches **First-Expiry-First-Out** (or a batch you choose). Voiding an entry posts a `REVERSAL`, so the stock goes back to the same batch.

```
MSD / vendor ──GRN──▶ Batch (no., expiry, supplier, invoice) ──▶ Ledger ──▶ Dispensing Register ──▶ Patient
                                                                  └──────▶ Issue to ward / write-off / return
```

## What's in the app

The app has just two sections.

**Ledger**
- **Stock card:** every movement of an item with a running balance. Each row shows the date, type, GRN or register number, supplier/patient/ward, batch, expiry, quantity in and out, balance and user. Prints, and exports to CSV.
- **Receive stock:** a goods received note (GRN) for each delivery from MSD or a vendor, with invoice, delivery note and checked-by witness. Each line holds batch no, expiry, quantity and unit cost. Expired stock is refused. Prints a GRN.
- **Issue / adjust:** issues to wards/units, returns in and out, expired/damaged write-offs, and corrections (a reason is required).
- **Items & suppliers:** the list of medicines and where they come from.

**Dispensing register**
- **New entry:** date and patient ID / file no, then each item with its dosage. Batches are chosen first-expiry-first-out, never from expired stock and never beyond what is on hand. Prints a dispensing slip.
- **Register:** all entries by date range, with search and a controlled-medicines filter. Prints, and exports to CSV. An entry can be voided with a reason; it stays visible, struck through, and its stock returns to the ledger.

**Settings & backup:** facility name, current user, backup/restore, and office server sync.

## Getting it running

### Linux desktop (office PC)

Requires only Python 3 (already on Ubuntu/Debian/Fedora) and a browser (Chromium or Chrome recommended).

```bash
git clone <this repo> && cd Pharmacy-Inventory-Management
./install-linux.sh            # adds "Pharmacy Ledger" to the applications menu (optional)
./run-desktop.sh --key ChooseASecret
```

This starts the office server, which keeps the master copy in `~/.local/share/pharmacy-ledger/server.db`, and opens the app in its own window. The terminal prints the address other devices should use, e.g. `http://192.168.1.20:8765`.

### Android phone / tablet

Choose one:

1. **Same Wi-Fi as the office PC (live sync):** open Chrome and go to the address printed by the server (for example `http://192.168.1.20:8765`). Enter the sync key under *Settings & sync*. Then use ⋮ → *Add to Home screen*. Records made on the tablet reach the PC within seconds, and the PC's records reach the tablet.
2. **Installable offline app (HTTPS):** enable GitHub Pages for this repository (*Settings → Pages → Source: GitHub Actions*). The included workflow publishes the app. Open the Pages URL in Chrome and use ⋮ → *Install app*. It works with no network at all. Move data to and from the PC with backup files (see below).

### First use

1. Enter the facility name, your name, and a **device code** (e.g. `PC1`, `TAB1`). The code goes into GRN and register numbers (`GRN-PC1-2026-00001`, `DR-TAB1-2026-00001`), so numbers never clash between devices.
2. Add items under **Ledger → Items & suppliers**.
3. Record the stock already on your shelves under **Ledger → Receive stock** from the supplier **“Opening balance”**, with the real batch numbers and expiry dates.
4. From then on: record every delivery under **Ledger → Receive stock**, every prescription under **Dispensing register → New entry**, and everything else under **Ledger → Issue / adjust**.

## Keeping data safe and in sync

- Each device keeps its own copy in the browser's storage (IndexedDB) and works fully offline.
- **Office server sync:** a device opened from the server's address syncs automatically after every save and every 3 minutes. If the server is off, the device keeps working and catches up later.
- **Backup files:** use *Settings → Export backup* to save a `.json` file, and *Import / merge backup* on another device. Importing **merges**: records are matched by ID, so nothing is duplicated or lost. You can use this to move data between the phone and the PC by USB, email or WhatsApp.
- Back up the server database by copying `~/.local/share/pharmacy-ledger/server.db` while the server is stopped, or export a backup from any synced device.
- If two devices dispense the same last units before they sync, the stock card will show a **negative balance** so you can investigate.

## Development

Plain HTML/CSS/JavaScript (ES modules). There is no build step and no npm dependencies.

```
index.html, css/app.css      UI shell and styles (responsive, print styles)
js/model.js                  all business rules – pure functions, unit-tested
js/db.js                     IndexedDB storage (atomic saves)
js/app.js                    screens and routing
sw.js, manifest.webmanifest  offline support / installable app
server.py                    office server + sync API (Python standard library, SQLite)
tests/model.test.mjs         unit tests:  npm test
tests/e2e.mjs                browser test, PC + Android phone syncing:  npm run e2e  (needs Playwright)
```
