import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../js/model.js';

function setup() {
  let s = M.emptyState();
  s.settings.deviceCode = 'D1';
  const para = M.makeItem({ name: 'Paracetamol', strength: '500mg', form: 'Tablet', unit: 'tab', reorderLevel: 100 }, 'PIC');
  const morph = M.makeItem({ name: 'Morphine', strength: '10mg/ml', form: 'Injection', unit: 'amp', controlled: true }, 'PIC');
  const msd = M.makeSupplier({ name: 'MSD', kind: 'MSD' }, 'PIC');
  s = M.applyChanges(s, { items: [para, morph], suppliers: [msd] });
  return { s, para, morph, msd };
}

function receive(s, msd, lines, date = '2026-01-10') {
  return M.applyChanges(s, M.receiveStock(s, { date, supplierId: msd.id, invoiceNo: 'INV1', lines }, 'PIC'));
}

test('receipt creates GRN, batches and ledger entries', () => {
  const { s: s0, para, msd } = setup();
  const r = M.receiveStock(s0, {
    date: '2026-01-10', supplierId: msd.id, invoiceNo: 'INV1',
    lines: [
      { itemId: para.id, batchNo: 'a1', expiry: '2027-01-01', qty: 1000, unitCost: 20 },
      { itemId: para.id, batchNo: 'B2', expiry: '2026-06-01', qty: 500, unitCost: 20 },
    ],
  }, 'PIC');
  assert.equal(r.receipts[0].grnNo, 'GRN-D1-2026-00001');
  assert.equal(r.batches.length, 2);
  assert.equal(r.batches[0].batchNo, 'A1');
  const s = M.applyChanges(s0, r);
  assert.equal(M.itemBalances(s).get(para.id), 1500);
  const r2 = M.receiveStock(s, { date: '2026-02-01', supplierId: msd.id, lines: [{ itemId: para.id, batchNo: 'A1', expiry: '2027-01-01', qty: 10 }] });
  assert.equal(r2.batches.length, 0, 'same batch number reuses existing batch');
  assert.equal(r2.receipts[0].grnNo, 'GRN-D1-2026-00002');
});

test('receipt rejects expired stock and expiry mismatch', () => {
  const { s, para, msd } = setup();
  assert.throws(() => M.receiveStock(s, { date: '2026-01-10', supplierId: msd.id, lines: [{ itemId: para.id, batchNo: 'X', expiry: '2026-01-01', qty: 1 }] }), /expired/);
  const s1 = receive(s, msd, [{ itemId: para.id, batchNo: 'X', expiry: '2027-01-01', qty: 1 }]);
  assert.throws(() => M.receiveStock(s1, { date: '2026-01-11', supplierId: msd.id, lines: [{ itemId: para.id, batchNo: 'X', expiry: '2028-01-01', qty: 1 }] }), /already exists/);
});

test('dispense uses FEFO, splits batches and posts to ledger', () => {
  const { s: s0, para, msd } = setup();
  const s = receive(s0, msd, [
    { itemId: para.id, batchNo: 'LATE', expiry: '2027-01-01', qty: 100 },
    { itemId: para.id, batchNo: 'EARLY', expiry: '2026-06-01', qty: 30 },
  ]);
  const r = M.dispense(s, { date: '2026-02-01', patientName: 'John Doe', patientId: 'P1', lines: [{ itemId: para.id, qty: 50, dosage: '2 tds x5' }] }, 'PIC');
  const d = r.dispenses[0];
  assert.equal(d.serialNo, 'DR-D1-2026-00001');
  assert.deepEqual(d.lines[0].allocations.map((a) => [a.batchNo, a.qty]), [['EARLY', 30], ['LATE', 20]]);
  assert.equal(r.txns.length, 2);
  const s1 = M.applyChanges(s, r);
  assert.equal(M.itemBalances(s1).get(para.id), 80);
  const card = M.stockCard(s1, para.id);
  assert.equal(card.closing, 80);
  assert.equal(card.rows.at(-1).balance, 80);
});

test('dispense refuses expired stock and over-dispensing', () => {
  const { s: s0, para, msd } = setup();
  const s = receive(s0, msd, [{ itemId: para.id, batchNo: 'E', expiry: '2026-03-01', qty: 100 }]);
  assert.throws(() => M.dispense(s, { date: '2026-04-01', patientName: 'X', lines: [{ itemId: para.id, qty: 1 }] }), /Not enough usable stock/);
  assert.throws(() => M.dispense(s, { date: '2026-02-01', patientName: 'X', lines: [{ itemId: para.id, qty: 101 }] }), /Not enough/);
  const batch = s.batches[0];
  assert.throws(() => M.dispense(s, { date: '2026-04-01', patientName: 'X', lines: [{ itemId: para.id, qty: 1, batchId: batch.id }] }), /expired/);
});

test('two lines of the same item cannot exceed stock together', () => {
  const { s: s0, para, msd } = setup();
  const s = receive(s0, msd, [{ itemId: para.id, batchNo: 'A', expiry: '2027-01-01', qty: 10 }]);
  assert.throws(() => M.dispense(s, { date: '2026-02-01', patientName: 'X', lines: [{ itemId: para.id, qty: 6 }, { itemId: para.id, qty: 6 }] }), /Not enough/);
});

test('register entry keeps only date, patient name and ID; controlled filter works', () => {
  const { s: s0, morph, msd } = setup();
  const s = receive(s0, msd, [{ itemId: morph.id, batchNo: 'M1', expiry: '2027-01-01', qty: 10 }]);
  const r = M.dispense(s, { date: '2026-02-01', patientName: 'X', patientId: 'F-12', age: '40', prescriber: 'Dr A', lines: [{ itemId: morph.id, qty: 1 }] });
  const d = r.dispenses[0];
  assert.equal(d.patientId, 'F-12');
  for (const k of ['age', 'sex', 'address', 'prescriber', 'rxNo', 'diagnosis']) assert.equal(k in d, false, k);
  assert.equal(r.txns.length, 1);
  const s1 = M.applyChanges(s, r);
  assert.equal(M.dispensingRegister(s1, { controlledOnly: true }).length, 1);
});

test('void restores stock via reversal and keeps the register row', () => {
  const { s: s0, para, msd } = setup();
  let s = receive(s0, msd, [{ itemId: para.id, batchNo: 'A', expiry: '2027-01-01', qty: 10 }]);
  s = M.applyChanges(s, M.dispense(s, { date: '2026-02-01', patientName: 'X', lines: [{ itemId: para.id, qty: 4 }] }));
  const id = s.dispenses[0].id;
  assert.throws(() => M.voidDispense(s, id, ''), /Reason/);
  s = M.applyChanges(s, M.voidDispense(s, id, 'wrong patient', 'PIC'));
  assert.equal(M.itemBalances(s).get(para.id), 10);
  assert.equal(s.dispenses[0].voided, true);
  assert.throws(() => M.voidDispense(s, id, 'again'), /already void/);
  assert.equal(M.stockCard(s, para.id).rows.map((r) => r.type).join(), 'RECEIPT,DISPENSE,REVERSAL');
});

test('movements: issue, write-off expired, adjustments', () => {
  const { s: s0, para, msd } = setup();
  let s = receive(s0, msd, [{ itemId: para.id, batchNo: 'A', expiry: '2026-03-01', qty: 100 }]);
  const b = s.batches[0];
  assert.throws(() => M.postMovement(s, { type: 'ISSUE', date: '2026-02-01', batchId: b.id, qty: 10 }), /ward/);
  s = M.applyChanges(s, M.postMovement(s, { type: 'ISSUE', date: '2026-02-01', batchId: b.id, qty: 10, party: 'Ward 3' }));
  assert.throws(() => M.postMovement(s, { type: 'ISSUE', date: '2026-04-01', batchId: b.id, qty: 1, party: 'W' }), /expired/);
  s = M.applyChanges(s, M.postMovement(s, { type: 'EXPIRED', date: '2026-04-01', batchId: b.id, qty: 90 }));
  assert.equal(M.batchBalances(s).get(b.id), 0);
  assert.throws(() => M.postMovement(s, { type: 'ADJUST_IN', date: '2026-04-01', batchId: b.id, qty: 1 }), /Reason/);
  assert.throws(() => M.postMovement(s, { type: 'DAMAGED', date: '2026-04-01', batchId: b.id, qty: 1, remarks: 'x' }), /only 0/);
});

test('dispensing register filters by date and search text', () => {
  const { s: s0, para, msd } = setup();
  let s = receive(s0, msd, [{ itemId: para.id, batchNo: 'A', expiry: '2027-01-01', qty: 100 }]);
  s = M.applyChanges(s, M.dispense(s, { date: '2026-02-05', patientName: 'Asha', patientId: 'P77', lines: [{ itemId: para.id, qty: 10 }] }));
  s = M.applyChanges(s, M.dispense(s, { date: '2026-03-05', patientName: 'Juma', lines: [{ itemId: para.id, qty: 5 }] }));
  assert.equal(M.dispensingRegister(s, { from: '2026-03-01' }).length, 1);
  assert.equal(M.dispensingRegister(s, { q: 'p77' })[0].patientName, 'Asha');
  assert.equal(M.dispensingRegister(s, { q: 'paracetamol' }).length, 2);
});

test('stock card opening balance and date range', () => {
  const { s: s0, para, msd } = setup();
  let s = receive(s0, msd, [{ itemId: para.id, batchNo: 'A', expiry: '2027-01-01', qty: 100 }], '2026-01-10');
  s = M.applyChanges(s, M.dispense(s, { date: '2026-02-05', patientName: 'X', lines: [{ itemId: para.id, qty: 10 }] }));
  s = M.applyChanges(s, M.dispense(s, { date: '2026-03-05', patientName: 'Y', lines: [{ itemId: para.id, qty: 5 }] }));
  const card = M.stockCard(s, para.id, { from: '2026-02-01', to: '2026-02-28' });
  assert.equal(card.opening, 100);
  assert.equal(card.rows.length, 1);
  assert.equal(card.closing, 90);
});

test('merge unions ledger entries and keeps newest master data', () => {
  const { s: base, para, msd } = setup();
  const devA = receive(base, msd, [{ itemId: para.id, batchNo: 'A', expiry: '2027-01-01', qty: 100 }]);
  const devB = M.applyChanges(devA, M.dispense(devA, { date: '2026-02-01', patientName: 'X', lines: [{ itemId: para.id, qty: 5 }] }));
  const devA2 = M.applyChanges(devA, M.dispense(devA, { date: '2026-02-01', patientName: 'Y', lines: [{ itemId: para.id, qty: 7 }] }));
  const renamed = { ...para, name: 'Paracetamol (Panadol)', updatedAt: '2999-01-01T00:00:00Z' };
  const merged = M.applyChanges(devA2, { txns: devB.txns, dispenses: devB.dispenses, items: [renamed] });
  assert.equal(M.itemBalances(merged).get(para.id), 88);
  assert.equal(merged.dispenses.length, 2);
  assert.equal(merged.items.find((i) => i.id === para.id).name, 'Paracetamol (Panadol)');
  const again = M.mergeCollection(merged.txns, devB.txns);
  assert.equal(again.changed.length, 0, 'merge is idempotent');
});

test('edits made in the same millisecond still win a merge', () => {
  const { s, para } = setup();
  for (let i = 0; i < 50; i++) {
    const edited = M.makeItem({ ...para, name: 'Edited ' + i }, 'PIC');
    assert.ok(edited.updatedAt > para.updatedAt);
    assert.equal(M.applyChanges(s, { items: [edited] }).items.find((x) => x.id === para.id).name, 'Edited ' + i);
  }
});

test('csv escaping', () => {
  const csv = M.toCsv([{ a: 'x,y', b: 'say "hi"' }], [{ label: 'A', get: 'a' }, { label: 'B', get: (r) => r.b }]);
  assert.equal(csv, 'A,B\r\n"x,y","say ""hi"""');
});
