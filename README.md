# Pharmacy-Inventory-Management
Stock inventory control, Management and tracing

**Pharmacy Ledger & Dispensing Register** – one app for the pharmacist in charge to control and trace every item from the moment it arrives from MSD or a vendor to the patient who receives it.

It runs on **Android** (phone/tablet) and **Linux desktop**, works **offline**, and several devices can work as **one system** through a small office server on the Linux PC.

## The two models, linked

| | **Ledger** (stock control) | **Dispensing Register** (patients) |
|---|---|---|
| Records | Goods received (GRN), issues to wards/units, returns, expiry & damage write-offs, stock-take adjustments | Every prescription: serial no, date, patient, ID, age/sex, prescriber, Rx no, diagnosis, items, dosage, batch, dispenser |
| View | Stock card (bin card) per item with running balance | Register by date range; controlled-medicines register |
| Rules | Append-only: entries are never edited or deleted, only reversed | Voided entries stay visible, struck through, with reason and who voided them |

**The link:** both share one batch-level stock database. Saving a register entry posts `DISPENSE` lines to the ledger automatically, picking batches **First-Expiry-First-Out** (or a batch you choose). Voiding an entry posts a `REVERSAL`, so the stock goes back to the same batch.

```
MSD / vendor ──GRN──▶ Batch (no., expiry, supplier, invoice) ──▶ Ledger ──▶ Dispensing Register ──▶ Patient
                                                                  └──────▶ Issue to ward / write-off / return
```

## Features

- **Receive stock (GRN):** supplier, invoice, delivery note, order no, checked-by witness; batch no, expiry, quantity and unit cost per line. Rejects expired stock, and rejects a batch number that already exists with a different expiry. Prints a GRN.
- **Dispense:** FEFO allocation across batches, never from expired stock, never beyond what is on hand. Controlled medicines require prescriber and prescription number. Prints a dispensing slip.
- **Issue / adjust:** issue to wards/units, returns in and out, expired/damaged write-offs, and corrections (a reason is required).
- **Stock take:** a printable count sheet; only the differences are posted, with the count recorded.
- **Trace:** search a batch and see its supplier, GRN, invoice, date and receiver, every movement, the balance left, and the **recall list** of every patient or unit that received it (exports to CSV). You can also search a patient to see everything they received.
- **Reports:** stock status (on hand, value, average monthly consumption, months of stock), expiry (30/90/180/365 days), order/requisition suggestions for MSD, and a movement summary (opening → received → dispensed/issued/lost → closing). Every report exports to CSV and prints.
- **Dashboard:** stock-outs, items at re-order level, expired batches still on the shelf, batches expiring within 90 days, and a reminder when there has been no backup in 7 days.
- **Accountability:** every entry records the signed-in user. You switch user in Settings at shift handover.
- Item list import from CSV. Light and dark themes. Print-friendly pages.

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
2. Add items under **Items & suppliers**, one at a time or by CSV import with the columns `name, strength, form, unit, code, category, reorderLevel, controlled`.
3. Record the stock already on your shelves as a **Receive stock** from the supplier **“Opening balance”**, with the real batch numbers and expiry dates.
4. From then on: record every delivery under **Receive**, every prescription under **Dispense**, and everything else under **Issue / adjust**.

## Keeping data safe and in sync

- Each device keeps its own copy in the browser's storage (IndexedDB) and works fully offline.
- **Office server sync:** a device opened from the server's address syncs automatically after every save and every 3 minutes. If the server is off, the device keeps working and catches up later.
- **Backup files:** use *Settings → Export backup* to save a `.json` file, and *Import / merge backup* on another device. Importing **merges**: records are matched by ID, so nothing is duplicated or lost. You can use this to move data between the phone and the PC by USB, email or WhatsApp.
- Back up the server database by copying `~/.local/share/pharmacy-ledger/server.db` while the server is stopped, or export a backup from any synced device.
- If two devices dispense the same last units before they sync, the dashboard flags the batch's **negative balance** so you can investigate.

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
