// Core business logic for the pharmacy Ledger + Dispensing Register.
// Pure functions over a plain `state` object so they run the same in the
// browser and in Node tests. Nothing here touches storage or the DOM.
//
// state = { items, suppliers, batches, receipts, txns, dispenses, settings }
//
// Design rules
//  * Stock is held per BATCH. On-hand quantity is never stored; it is always
//    derived from the ledger transactions, so the ledger is the single source
//    of truth and records from several devices can be merged safely.
//  * Ledger transactions are append-only. Mistakes are corrected with a
//    REVERSAL entry, never by editing or deleting a row.
//  * Every dispense posts DISPENSE transactions to the ledger automatically,
//    which is what links the Dispensing Register to the Ledger.

export const COLLECTIONS = ['items', 'suppliers', 'batches', 'receipts', 'txns', 'dispenses'];

export const TXN_TYPES = {
  RECEIPT:    { label: 'Received (GRN)',        dir: 1 },
  RETURN_IN:  { label: 'Returned in',           dir: 1 },
  ADJUST_IN:  { label: 'Adjustment (+)',        dir: 1 },
  DISPENSE:   { label: 'Dispensed',             dir: -1 },
  ISSUE:      { label: 'Issued to unit',        dir: -1 },
  RETURN_OUT: { label: 'Returned to supplier',  dir: -1 },
  EXPIRED:    { label: 'Expired – written off', dir: -1 },
  DAMAGED:    { label: 'Damaged / lost',        dir: -1 },
  ADJUST_OUT: { label: 'Adjustment (−)',        dir: -1 },
  REVERSAL:   { label: 'Reversal',              dir: 0 },
};

// Movement types a user may post by hand from the "Movements" screen.
export const MANUAL_TYPES = ['ISSUE', 'RETURN_IN', 'RETURN_OUT', 'EXPIRED', 'DAMAGED', 'ADJUST_IN', 'ADJUST_OUT'];

export function emptyState() {
  return { items: [], suppliers: [], batches: [], receipts: [], txns: [], dispenses: [], settings: {} };
}

// ---------------------------------------------------------------- utilities

export function newId() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  // randomUUID is missing on plain-http pages (e.g. LAN access); build a v4 UUID by hand.
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function isDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}

function toQty(v, what = 'Quantity') {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${what} must be a number greater than zero`);
  return n;
}

function req(v, what) {
  if (v === undefined || v === null || String(v).trim() === '') throw new Error(`${what} is required`);
  return String(v).trim();
}

// A timestamp strictly later than `prev`, so an edit always wins a merge
// even when it happens within the same millisecond as the original save.
function laterThan(prev) {
  const now = Date.now();
  const p = prev ? Date.parse(prev) : 0;
  return new Date(Math.max(now, p + 1)).toISOString();
}

function stamp(rec, user) {
  const t = nowIso();
  return { ...rec, createdAt: rec.createdAt || t, updatedAt: laterThan(rec.updatedAt), createdBy: rec.createdBy || user || '' };
}

const byId = (arr) => new Map(arr.map((r) => [r.id, r]));

function txnOrder(a, b) {
  return a.date < b.date ? -1 : a.date > b.date ? 1 : a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
}

// Next document number for this device, e.g. "GRN-D1-2026-00012".
export function nextDocNo(records, field, prefix, deviceCode, date) {
  const year = (date || today()).slice(0, 4);
  const stem = `${prefix}-${deviceCode || 'D1'}-${year}-`;
  let max = 0;
  for (const r of records) {
    const v = r[field];
    if (typeof v === 'string' && v.startsWith(stem)) max = Math.max(max, parseInt(v.slice(stem.length), 10) || 0);
  }
  return stem + String(max + 1).padStart(5, '0');
}

// ------------------------------------------------------------- master data

export function makeItem(input, user) {
  const item = {
    id: input.id || newId(),
    code: String(input.code || '').trim(),
    name: req(input.name, 'Item name'),
    strength: String(input.strength || '').trim(),
    form: String(input.form || '').trim(),
    unit: req(input.unit || 'unit', 'Unit of issue'),
    category: String(input.category || '').trim(),
    controlled: !!input.controlled,
    reorderLevel: Number(input.reorderLevel) || 0,
    active: input.active !== false,
    createdAt: input.createdAt,
    createdBy: input.createdBy,
    updatedAt: input.updatedAt,
  };
  return stamp(item, user);
}

export function makeSupplier(input, user) {
  return stamp({
    id: input.id || newId(),
    name: req(input.name, 'Supplier name'),
    kind: input.kind || 'Vendor', // MSD | Vendor | Donor | Other facility
    contact: String(input.contact || '').trim(),
    createdAt: input.createdAt,
    createdBy: input.createdBy,
    updatedAt: input.updatedAt,
  }, user);
}

export function itemLabel(item) {
  if (!item) return '(unknown item)';
  return [item.name, item.strength, item.form].filter(Boolean).join(' ');
}

// ---------------------------------------------------------------- balances

export function batchBalances(state) {
  const m = new Map();
  for (const t of state.txns) m.set(t.batchId, (m.get(t.batchId) || 0) + t.qty);
  return m;
}

export function itemBalances(state) {
  const m = new Map();
  for (const t of state.txns) m.set(t.itemId, (m.get(t.itemId) || 0) + t.qty);
  return m;
}

// Batches of an item that still hold stock, earliest expiry first (FEFO).
export function availableBatches(state, itemId, asOf = today(), balances = batchBalances(state)) {
  return state.batches
    .filter((b) => b.itemId === itemId && (balances.get(b.id) || 0) > 0)
    .map((b) => ({ ...b, balance: balances.get(b.id) || 0, expired: b.expiry < asOf }))
    .sort((a, b) => (a.expiry < b.expiry ? -1 : a.expiry > b.expiry ? 1 : (a.receivedDate || '') < (b.receivedDate || '') ? -1 : 1));
}

// Pick batches First-Expiry-First-Out. Expired stock is never allocated.
export function allocateFEFO(state, itemId, qty, asOf = today(), balances = batchBalances(state)) {
  let left = toQty(qty);
  const out = [];
  for (const b of availableBatches(state, itemId, asOf, balances)) {
    if (b.expired) continue;
    const take = Math.min(left, b.balance);
    out.push({ batchId: b.id, qty: take });
    left -= take;
    if (left <= 0) break;
  }
  if (left > 0) {
    const item = state.items.find((i) => i.id === itemId);
    const have = qty - left;
    throw new Error(`Not enough usable stock of ${itemLabel(item)}: need ${qty}, have ${have} (expired stock excluded)`);
  }
  return out;
}

function checkBatchOut(state, batchId, qty, asOf, balances, { allowExpired = false } = {}) {
  const b = state.batches.find((x) => x.id === batchId);
  if (!b) throw new Error('Batch not found');
  const bal = balances.get(batchId) || 0;
  if (qty > bal) throw new Error(`Batch ${b.batchNo} has only ${bal} in stock`);
  if (!allowExpired && b.expiry < asOf) throw new Error(`Batch ${b.batchNo} expired on ${b.expiry}`);
  return b;
}

// -------------------------------------------------------- receiving (GRN)

// Receive stock from MSD / a vendor. Creates the GRN, any new batches, and a
// RECEIPT ledger entry per line. Returns records to persist.
export function receiveStock(state, input, user) {
  const date = req(input.date, 'Date');
  if (!isDate(date)) throw new Error('Date must be YYYY-MM-DD');
  const supplier = state.suppliers.find((s) => s.id === input.supplierId);
  if (!supplier) throw new Error('Supplier is required');
  if (!input.lines || !input.lines.length) throw new Error('Add at least one item line');

  const receiptId = newId();
  const grnNo = nextDocNo(state.receipts, 'grnNo', 'GRN', state.settings.deviceCode, date);
  const batches = [];
  const txns = [];
  const lines = [];
  const knownBatches = [...state.batches];

  input.lines.forEach((l, i) => {
    const n = i + 1;
    const item = state.items.find((it) => it.id === l.itemId);
    if (!item) throw new Error(`Line ${n}: choose an item`);
    const batchNo = req(l.batchNo, `Line ${n}: batch number`).toUpperCase();
    const expiry = req(l.expiry, `Line ${n}: expiry date`);
    if (!isDate(expiry)) throw new Error(`Line ${n}: expiry must be YYYY-MM-DD`);
    if (expiry <= date) throw new Error(`Line ${n}: ${itemLabel(item)} batch ${batchNo} is already expired`);
    const qty = toQty(l.qty, `Line ${n}: quantity`);
    const unitCost = Number(l.unitCost) || 0;

    let batch = knownBatches.find((b) => b.itemId === item.id && b.batchNo === batchNo);
    if (batch && batch.expiry !== expiry) {
      throw new Error(`Line ${n}: batch ${batchNo} already exists with expiry ${batch.expiry}`);
    }
    if (!batch) {
      batch = stamp({
        id: newId(), itemId: item.id, batchNo, expiry, supplierId: supplier.id,
        receiptId, receivedDate: date, unitCost, manufacturer: String(l.manufacturer || '').trim(),
      }, user);
      batches.push(batch);
      knownBatches.push(batch);
    }
    txns.push(stamp({
      id: newId(), date, itemId: item.id, batchId: batch.id, type: 'RECEIPT', qty,
      ref: grnNo, docId: receiptId, party: supplier.name, user: user || '', remarks: input.invoiceNo ? `Inv ${input.invoiceNo}` : '',
    }, user));
    lines.push({ itemId: item.id, batchId: batch.id, batchNo, expiry, qty, unitCost });
  });

  const receipt = stamp({
    id: receiptId, grnNo, date, supplierId: supplier.id,
    invoiceNo: String(input.invoiceNo || '').trim(),
    deliveryNo: String(input.deliveryNo || '').trim(),
    orderNo: String(input.orderNo || '').trim(),
    receivedBy: user || '', checkedBy: String(input.checkedBy || '').trim(),
    remarks: String(input.remarks || '').trim(), lines,
  }, user);

  return { receipts: [receipt], batches, txns };
}

// -------------------------------------------------------------- dispensing

// Dispense to a patient. Creates a Dispensing Register entry and DISPENSE
// ledger entries (split across batches FEFO unless a batch is chosen).
export function dispense(state, input, user) {
  const date = req(input.date, 'Date');
  if (!isDate(date)) throw new Error('Date must be YYYY-MM-DD');
  const patientName = req(input.patientName, 'Patient name');
  if (!input.lines || !input.lines.length) throw new Error('Add at least one item');

  const balances = batchBalances(state);
  const dispenseId = newId();
  const serialNo = nextDocNo(state.dispenses, 'serialNo', 'DR', state.settings.deviceCode, date);
  const txns = [];
  const lines = [];

  input.lines.forEach((l, i) => {
    const n = i + 1;
    const item = state.items.find((it) => it.id === l.itemId);
    if (!item) throw new Error(`Line ${n}: choose an item`);
    const qty = toQty(l.qty, `Line ${n}: quantity`);
    if (item.controlled) {
      req(input.prescriber, `${itemLabel(item)} is a controlled medicine – prescriber`);
      req(input.rxNo, `${itemLabel(item)} is a controlled medicine – prescription number`);
    }
    let alloc;
    if (l.batchId) {
      checkBatchOut(state, l.batchId, qty, date, balances);
      alloc = [{ batchId: l.batchId, qty }];
    } else {
      alloc = allocateFEFO(state, item.id, qty, date, balances);
    }
    const allocations = alloc.map((a) => {
      balances.set(a.batchId, (balances.get(a.batchId) || 0) - a.qty); // keep later lines honest
      const b = state.batches.find((x) => x.id === a.batchId);
      txns.push(stamp({
        id: newId(), date, itemId: item.id, batchId: a.batchId, type: 'DISPENSE', qty: -a.qty,
        ref: serialNo, docId: dispenseId, party: patientName, user: user || '', remarks: '',
      }, user));
      return { batchId: a.batchId, batchNo: b.batchNo, expiry: b.expiry, qty: a.qty };
    });
    lines.push({ itemId: item.id, qty, dosage: String(l.dosage || '').trim(), allocations });
  });

  const record = stamp({
    id: dispenseId, serialNo, date, patientName,
    patientId: String(input.patientId || '').trim(),
    age: String(input.age || '').trim(),
    sex: String(input.sex || '').trim(),
    address: String(input.address || '').trim(),
    prescriber: String(input.prescriber || '').trim(),
    rxNo: String(input.rxNo || '').trim(),
    diagnosis: String(input.diagnosis || '').trim(),
    dispensedBy: user || '',
    lines,
    voided: false,
  }, user);

  return { dispenses: [record], txns };
}

// Cancel a register entry. The entry stays visible (marked void) and the
// stock goes back to the same batches through REVERSAL ledger entries.
export function voidDispense(state, dispenseId, reason, user) {
  const d = state.dispenses.find((x) => x.id === dispenseId);
  if (!d) throw new Error('Register entry not found');
  if (d.voided) throw new Error('Entry is already void');
  req(reason, 'Reason for voiding');
  const date = today();
  const txns = state.txns
    .filter((t) => t.docId === dispenseId && t.type === 'DISPENSE')
    .map((t) => stamp({
      id: newId(), date, itemId: t.itemId, batchId: t.batchId, type: 'REVERSAL', qty: -t.qty,
      ref: d.serialNo, docId: dispenseId, reversalOf: t.id, party: d.patientName, user: user || '',
      remarks: `Void: ${reason}`,
    }, user));
  const updated = { ...d, voided: true, voidReason: String(reason).trim(), voidedBy: user || '', voidedAt: nowIso(), updatedAt: laterThan(d.updatedAt) };
  return { dispenses: [updated], txns };
}

// ------------------------------------------------ other ledger movements

// Issue to a ward/unit, return, write-off or adjust a single batch.
export function postMovement(state, input, user) {
  const type = input.type;
  const spec = TXN_TYPES[type];
  if (!spec || !MANUAL_TYPES.includes(type)) throw new Error('Choose a movement type');
  const date = req(input.date, 'Date');
  if (!isDate(date)) throw new Error('Date must be YYYY-MM-DD');
  const qty = toQty(input.qty);
  const batch = state.batches.find((b) => b.id === input.batchId);
  if (!batch) throw new Error('Choose a batch');
  if (spec.dir < 0) {
    // Expired/damaged/returned stock may be removed even after expiry.
    checkBatchOut(state, batch.id, qty, date, batchBalances(state), { allowExpired: type !== 'ISSUE' });
  }
  if (type === 'ISSUE') req(input.party, 'Receiving unit / ward');
  if (type.startsWith('ADJUST') || type === 'DAMAGED') req(input.remarks, 'Reason');
  const txn = stamp({
    id: newId(), date, itemId: batch.itemId, batchId: batch.id, type, qty: spec.dir * qty,
    ref: String(input.ref || '').trim(), docId: '', party: String(input.party || '').trim(),
    user: user || '', remarks: String(input.remarks || '').trim(),
  }, user);
  return { txns: [txn] };
}

// ------------------------------------------------------------------ ledger

// Stock card (bin card) for one item: opening balance, every movement with
// running balance, closing balance.
export function stockCard(state, itemId, { from, to } = {}) {
  const batches = byId(state.batches);
  const all = state.txns.filter((t) => t.itemId === itemId).sort(txnOrder);
  let opening = 0;
  let bal = 0;
  const rows = [];
  for (const t of all) {
    if (from && t.date < from) { opening += t.qty; bal += t.qty; continue; }
    if (to && t.date > to) break;
    bal += t.qty;
    const b = batches.get(t.batchId);
    rows.push({
      ...t,
      batchNo: b ? b.batchNo : '',
      expiry: b ? b.expiry : '',
      qtyIn: t.qty > 0 ? t.qty : 0,
      qtyOut: t.qty < 0 ? -t.qty : 0,
      balance: bal,
    });
  }
  return { opening, rows, closing: bal };
}

// ----------------------------------------------------------------- reports

export function dispensingRegister(state, { from, to, q, controlledOnly } = {}) {
  const items = byId(state.items);
  const s = String(q || '').trim().toLowerCase();
  return state.dispenses
    .filter((d) => (!from || d.date >= from) && (!to || d.date <= to))
    .filter((d) => !controlledOnly || d.lines.some((l) => items.get(l.itemId)?.controlled))
    .filter((d) => !s || [d.serialNo, d.patientName, d.patientId, d.prescriber, d.rxNo]
      .concat(d.lines.map((l) => itemLabel(items.get(l.itemId))))
      .some((v) => String(v || '').toLowerCase().includes(s)))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.serialNo < b.serialNo ? -1 : 1));
}

// -------------------------------------------------------------------- sync

// Merge records from another device/backup. Records are matched by id; the
// newer `updatedAt` wins. Ledger entries are immutable, so for them this is
// a plain union.
export function mergeCollection(local, incoming) {
  const map = new Map(local.map((r) => [r.id, r]));
  const changed = [];
  for (const r of incoming || []) {
    if (!r || !r.id) continue;
    const cur = map.get(r.id);
    if (!cur || (r.updatedAt || '') > (cur.updatedAt || '')) {
      map.set(r.id, r);
      changed.push(r);
    }
  }
  return { merged: [...map.values()], changed };
}

export function applyChanges(state, changes) {
  const next = { ...state };
  for (const k of COLLECTIONS) {
    if (!changes[k] || !changes[k].length) continue;
    next[k] = mergeCollection(state[k], changes[k]).merged;
  }
  return next;
}

// ------------------------------------------------------------------- CSV

export function toCsv(rows, columns) {
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.map((c) => esc(c.label)).join(',')]
    .concat(rows.map((r) => columns.map((c) => esc(typeof c.get === 'function' ? c.get(r) : r[c.get])).join(',')))
    .join('\r\n');
}
