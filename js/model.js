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

function daysBetween(a, b) {
  return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
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

// Physical stock count. For every batch counted, posts an adjustment for the
// difference between the ledger balance and what is on the shelf.
export function stockTake(state, input, user) {
  const date = req(input.date, 'Date');
  const balances = batchBalances(state);
  const ref = String(input.ref || `COUNT ${date}`).trim();
  const txns = [];
  for (const c of input.counts || []) {
    if (c.counted === '' || c.counted === null || c.counted === undefined) continue;
    const counted = Number(c.counted);
    if (!Number.isFinite(counted) || counted < 0) throw new Error('Counted quantities must be zero or more');
    const batch = state.batches.find((b) => b.id === c.batchId);
    if (!batch) continue;
    const diff = counted - (balances.get(batch.id) || 0);
    if (diff === 0) continue;
    txns.push(stamp({
      id: newId(), date, itemId: batch.itemId, batchId: batch.id,
      type: diff > 0 ? 'ADJUST_IN' : 'ADJUST_OUT', qty: diff, ref, docId: '', party: 'Stock count',
      user: user || '', remarks: `Physical count ${counted}, ledger ${balances.get(batch.id) || 0}${input.remarks ? ' – ' + input.remarks : ''}`,
    }, user));
  }
  return { txns };
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

// ------------------------------------------------------------------- trace

// Full chain of custody for one batch: where it came from, every movement,
// and every patient/unit that received it (for recalls).
export function traceBatch(state, batchId) {
  const batch = state.batches.find((b) => b.id === batchId);
  if (!batch) return null;
  const item = state.items.find((i) => i.id === batch.itemId);
  const supplier = state.suppliers.find((s) => s.id === batch.supplierId);
  const receipt = state.receipts.find((r) => r.id === batch.receiptId);
  const movements = state.txns.filter((t) => t.batchId === batchId).sort(txnOrder);
  let bal = 0;
  const rows = movements.map((t) => ({ ...t, balance: (bal += t.qty) }));
  const dispById = byId(state.dispenses);
  const reversed = new Set(movements.filter((t) => t.reversalOf).map((t) => t.reversalOf));
  const recipients = movements
    .filter((t) => (t.type === 'DISPENSE' || t.type === 'ISSUE') && !reversed.has(t.id))
    .map((t) => {
      const d = t.docId ? dispById.get(t.docId) : null;
      return {
        date: t.date, type: t.type, qty: -t.qty, ref: t.ref, name: t.party,
        patientId: d ? d.patientId : '', contact: d ? d.address : '', prescriber: d ? d.prescriber : '',
      };
    });
  return { batch, item, supplier, receipt, movements: rows, balance: bal, recipients };
}

export function findBatches(state, query) {
  const q = String(query || '').trim().toUpperCase();
  if (!q) return [];
  const items = byId(state.items);
  return state.batches
    .filter((b) => b.batchNo.includes(q) || itemLabel(items.get(b.itemId)).toUpperCase().includes(q))
    .map((b) => ({ ...b, item: items.get(b.itemId) }));
}

// Everything a patient has received (search by name or patient ID).
export function patientHistory(state, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  return state.dispenses
    .filter((d) => d.patientName.toLowerCase().includes(q) || (d.patientId || '').toLowerCase().includes(q))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
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

// Average monthly consumption (dispensed + issued, net of reversals) over the
// last `months` months, per item.
export function consumption(state, { months = 3, asOf = today() } = {}) {
  const from = addDays(asOf, -Math.round(months * 30.44));
  const m = new Map();
  for (const t of state.txns) {
    if (t.date < from || t.date > asOf) continue;
    if (t.type === 'DISPENSE' || t.type === 'ISSUE') m.set(t.itemId, (m.get(t.itemId) || 0) - t.qty);
    else if (t.type === 'REVERSAL') m.set(t.itemId, (m.get(t.itemId) || 0) - t.qty);
  }
  const out = new Map();
  for (const [k, v] of m) out.set(k, v / months);
  return out;
}

// One row per item: stock on hand, value, AMC, months of stock, alerts and a
// suggested order quantity (to cover `targetMonths` of consumption).
export function stockStatus(state, { asOf = today(), months = 3, targetMonths = 3, nearExpiryDays = 90 } = {}) {
  const bb = batchBalances(state);
  const amc = consumption(state, { months, asOf });
  return state.items.filter((i) => i.active !== false).map((item) => {
    const batches = availableBatches(state, item.id, asOf, bb);
    const onHand = batches.reduce((s, b) => s + b.balance, 0);
    const expired = batches.filter((b) => b.expired).reduce((s, b) => s + b.balance, 0);
    const nearExpiry = batches.filter((b) => !b.expired && daysBetween(asOf, b.expiry) <= nearExpiryDays)
      .reduce((s, b) => s + b.balance, 0);
    const usable = onHand - expired;
    const value = batches.reduce((s, b) => s + b.balance * (b.unitCost || 0), 0);
    const a = amc.get(item.id) || 0;
    const mos = a > 0 ? usable / a : null;
    const suggested = Math.max(0, Math.ceil(a * targetMonths - usable));
    return {
      item, onHand, usable, expired, nearExpiry, value, amc: a, monthsOfStock: mos,
      belowReorder: item.reorderLevel > 0 && usable <= item.reorderLevel,
      stockOut: usable <= 0,
      suggestedOrder: suggested,
      nextExpiry: batches.find((b) => !b.expired)?.expiry || '',
    };
  });
}

export function expiryReport(state, { asOf = today(), days = 180 } = {}) {
  const bb = batchBalances(state);
  const items = byId(state.items);
  const limit = addDays(asOf, days);
  return state.batches
    .filter((b) => (bb.get(b.id) || 0) > 0 && b.expiry <= limit)
    .map((b) => ({
      ...b, item: items.get(b.itemId), balance: bb.get(b.id),
      daysLeft: daysBetween(asOf, b.expiry), value: bb.get(b.id) * (b.unitCost || 0),
    }))
    .sort((a, b) => (a.expiry < b.expiry ? -1 : 1));
}

// Batches whose ledger balance went negative – usually two devices dispensing
// the same stock before syncing, or a missing receipt.
export function integrityIssues(state) {
  const issues = [];
  const bb = batchBalances(state);
  const items = byId(state.items);
  for (const b of state.batches) {
    if ((bb.get(b.id) || 0) < 0) issues.push(`${itemLabel(items.get(b.itemId))} batch ${b.batchNo}: negative balance ${bb.get(b.id)}`);
  }
  const batchIds = new Set(state.batches.map((b) => b.id));
  const orphan = state.txns.filter((t) => !batchIds.has(t.batchId)).length;
  if (orphan) issues.push(`${orphan} ledger entries refer to a batch that is missing on this device – sync again`);
  return issues;
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
