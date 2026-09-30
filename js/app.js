// UI for the Pharmacy Ledger + Dispensing Register.
// Hash routes (#/dispense, #/ledger?item=…) render into <main id="view">.
import * as M from './model.js';
import * as DB from './db.js';

let S = M.emptyState();
const view = document.getElementById('view');

// ----------------------------------------------------------------- helpers

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => (n === null || n === undefined || n === '' ? '' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 }));
const money = (n) => Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const user = () => S.settings.currentUser || '';
const itemsById = () => new Map(S.items.map((i) => [i.id, i]));
const suppliersById = () => new Map(S.suppliers.map((s) => [s.id, s]));
const batchesById = () => new Map(S.batches.map((b) => [b.id, b]));
const monthStart = () => M.today().slice(0, 8) + '01';
const typeLabel = (t) => M.TXN_TYPES[t]?.label || t;

function itemKey(i) {
  return M.itemLabel(i) + (i.code ? ` [${i.code}]` : '');
}

function resolveItem(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  return S.items.find((i) => itemKey(i) === t) ||
    S.items.find((i) => itemKey(i).toLowerCase() === t.toLowerCase()) ||
    S.items.find((i) => i.code && i.code.toLowerCase() === t.toLowerCase()) || null;
}

function itemDatalist() {
  return `<datalist id="dl-items">${S.items.filter((i) => i.active !== false)
    .sort((a, b) => M.itemLabel(a).localeCompare(M.itemLabel(b)))
    .map((i) => `<option value="${esc(itemKey(i))}"></option>`).join('')}</datalist>`;
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2600);
}

function showError(container, err) {
  const box = container.querySelector('[data-error]');
  const msg = err && err.message ? err.message : String(err);
  if (box) { box.innerHTML = `<div class="alert bad">${esc(msg)}</div>`; box.scrollIntoView({ block: 'nearest' }); } else alert(msg);
}

async function commit(changes) {
  await DB.saveChanges(changes);
  S = M.applyChanges(S, changes);
  scheduleSync();
}

async function setSetting(key, value) {
  await DB.saveSetting(key, value);
  S.settings[key] = value;
}

function download(name, text, type = 'text/csv') {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

function route() {
  const h = location.hash.replace(/^#\/?/, '');
  const [path, qs] = h.split('?');
  return { parts: (path || 'dashboard').split('/'), params: new URLSearchParams(qs || '') };
}

function go(path, params) {
  const qs = params ? new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v != null && v !== false)).toString() : '';
  location.hash = '#/' + path + (qs ? '?' + qs : '');
}

function pill(text, kind = '') {
  return `<span class="pill ${kind}">${esc(text)}</span>`;
}

function table(headers, rows, { foot = '', empty = 'Nothing to show yet.' } = {}) {
  if (!rows.length) return `<div class="table-wrap"><div class="empty">${esc(empty)}</div></div>`;
  return `<div class="table-wrap"><table><thead><tr>${headers.map((h) => {
    const [label, cls] = Array.isArray(h) ? h : [h, ''];
    return `<th class="${cls}">${esc(label)}</th>`;
  }).join('')}</tr></thead><tbody>${rows.join('')}</tbody>${foot}</table></div>`;
}

function printHeader(title, extra = '') {
  return `<div class="print-only"><strong>${esc(S.settings.facility || '')}</strong> — ${esc(title)} ${extra}
    <br><small>Printed ${new Date().toLocaleString()} by ${esc(user())}</small><hr></div>`;
}

// ---------------------------------------------------------------- routing

const VIEWS = {
  dashboard: vDashboard, receive: vReceive, dispense: vDispense, movements: vMovements,
  stocktake: vStockTake, ledger: vLedger, register: vRegister, trace: vTrace,
  reports: vReports, items: vItems, settings: vSettings, doc: vDoc,
};

function render() {
  const r = route();
  document.getElementById('facility').textContent = S.settings.facility || '';
  document.getElementById('who').innerHTML = user()
    ? `Signed in: <b>${esc(user())}</b> · <a href="#/settings">change</a>` : '';
  for (const a of document.querySelectorAll('#nav a')) {
    a.classList.toggle('active', a.getAttribute('href') === '#/' + r.parts[0]);
  }
  if (!S.settings.currentUser || !S.settings.facility) return vSetup();
  const fn = VIEWS[r.parts[0]] || vDashboard;
  try {
    fn(r);
  } catch (e) {
    console.error(e);
    view.innerHTML = `<div class="alert bad">Something went wrong: ${esc(e.message)}</div>`;
  }
  window.scrollTo(0, 0);
}

// ------------------------------------------------------------------ setup

function vSetup() {
  view.innerHTML = `
    <h1>Welcome</h1>
    <p class="sub">Set up this device. You can change these later under Settings.</p>
    <form class="panel" id="f">
      <div data-error></div>
      <div class="grid">
        <label>Facility / pharmacy name <input name="facility" required value="${esc(S.settings.facility || '')}"></label>
        <label>Your name (pharmacist in charge) <input name="currentUser" required value="${esc(S.settings.currentUser || '')}"></label>
        <label>Device code <input name="deviceCode" required maxlength="4" value="${esc(S.settings.deviceCode || 'D1')}">
          <div class="hint">Short and unique per device (e.g. PC1, TAB1). Used in GRN and register numbers so devices never clash.</div></label>
      </div>
      <div class="actions"><button class="btn primary">Start</button></div>
    </form>
    <div class="panel"><b>Moving from another device?</b> Finish setup, then use <i>Settings &amp; sync → Import backup</i>.</div>`;
  view.querySelector('#f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    await setSetting('facility', fd.get('facility').trim());
    await setSetting('currentUser', fd.get('currentUser').trim());
    await setSetting('deviceCode', fd.get('deviceCode').trim().toUpperCase().replace(/[^A-Z0-9]/g, '') || 'D1');
    const staff = new Set(S.settings.staff || []);
    staff.add(S.settings.currentUser);
    await setSetting('staff', [...staff]);
    if (!S.suppliers.length) {
      await commit({ suppliers: [
        // Fixed ids so every device's defaults merge into one record.
        { ...M.makeSupplier({ id: 'default-msd', name: 'MSD', kind: 'MSD' }, user()), updatedAt: '2000-01-01T00:00:00.000Z' },
        { ...M.makeSupplier({ id: 'default-opening', name: 'Opening balance', kind: 'Other' }, user()), updatedAt: '2000-01-01T00:00:00.000Z' },
      ] });
    }
    go('dashboard');
    render();
  });
}

// -------------------------------------------------------------- dashboard

function vDashboard() {
  const st = M.stockStatus(S, { nearExpiryDays: 90 });
  const t = M.today();
  const todays = S.dispenses.filter((d) => d.date === t && !d.voided);
  const out = st.filter((r) => r.stockOut);
  const low = st.filter((r) => r.belowReorder && !r.stockOut);
  const expired = M.expiryReport(S, { days: 0 }).filter((b) => b.daysLeft < 0);
  const near = M.expiryReport(S, { days: 90 }).filter((b) => b.daysLeft >= 0);
  const value = st.reduce((s, r) => s + r.value, 0);
  const issues = M.integrityIssues(S);
  const lastBackup = S.settings.lastBackup;
  const backupOld = !lastBackup || (Date.now() - Date.parse(lastBackup)) > 7 * 86400000;

  const list = (rows, fn) => rows.length ? `<ul>${rows.slice(0, 12).map(fn).join('')}</ul>${rows.length > 12 ? `<p class="hint">…and ${rows.length - 12} more</p>` : ''}` : '<p class="empty">None</p>';

  view.innerHTML = `
    <h1>Dashboard</h1>
    <p class="sub">${esc(S.settings.facility)} · ${new Date().toDateString()}</p>
    ${issues.map((i) => `<div class="alert bad">${esc(i)}</div>`).join('')}
    ${S.items.length === 0 ? `<div class="alert ok">Start by adding your items under <a href="#/items">Items &amp; suppliers</a>, then record stock with <a href="#/receive">Receive stock</a>. For stock already on the shelf, receive it from the supplier “Opening balance”.</div>` : ''}
    ${backupOld && S.txns.length ? `<div class="alert warn">No backup in the last 7 days. <a href="#/settings">Back up now</a>.</div>` : ''}
    <div class="stats">
      <div class="stat"><b>${S.items.filter((i) => i.active !== false).length}</b><span>Active items</span></div>
      <div class="stat"><b>${money(value)}</b><span>Stock value</span></div>
      <div class="stat"><b>${todays.length}</b><span>Prescriptions today</span></div>
      <div class="stat ${out.length ? 'bad' : ''}"><b>${out.length}</b><span>Stock-outs</span></div>
      <div class="stat ${low.length ? 'warn' : ''}"><b>${low.length}</b><span>At/below re-order level</span></div>
      <div class="stat ${near.length ? 'warn' : ''}"><b>${near.length}</b><span>Batches expiring ≤ 90 days</span></div>
      <div class="stat ${expired.length ? 'bad' : ''}"><b>${expired.length}</b><span>Expired batches on shelf</span></div>
    </div>
    <div class="actions no-print" style="margin:0 0 16px">
      <a class="btn primary" href="#/dispense">Dispense</a>
      <a class="btn" href="#/receive">Receive stock</a>
      <a class="btn" href="#/trace">Trace a batch</a>
    </div>
    <div class="grid">
      <div class="panel"><h2 style="margin-top:0">Stock-outs</h2>
        ${list(out, (r) => `<li><a href="#/ledger?item=${r.item.id}">${esc(M.itemLabel(r.item))}</a></li>`)}</div>
      <div class="panel"><h2 style="margin-top:0">Re-order now</h2>
        ${list(low, (r) => `<li><a href="#/ledger?item=${r.item.id}">${esc(M.itemLabel(r.item))}</a> — ${fmt(r.usable)} ${esc(r.item.unit)} (level ${fmt(r.item.reorderLevel)})</li>`)}</div>
      <div class="panel"><h2 style="margin-top:0">Expired – remove from shelf</h2>
        ${list(expired, (b) => `<li><a href="#/trace?batch=${b.id}">${esc(M.itemLabel(b.item))} · ${esc(b.batchNo)}</a> — ${fmt(b.balance)} (exp ${esc(b.expiry)})</li>`)}</div>
      <div class="panel"><h2 style="margin-top:0">Expiring within 90 days</h2>
        ${list(near, (b) => `<li><a href="#/trace?batch=${b.id}">${esc(M.itemLabel(b.item))} · ${esc(b.batchNo)}</a> — ${fmt(b.balance)}, ${b.daysLeft} days</li>`)}</div>
    </div>`;
}

// ---------------------------------------------------------- receive (GRN)

function receiveLine() {
  return `<div class="line" data-line>
    <label class="wide">Item <input list="dl-items" name="item" autocomplete="off" placeholder="Type to search"></label>
    <label>Batch / lot no <input name="batchNo" autocomplete="off"></label>
    <label>Expiry <input type="date" name="expiry"></label>
    <label>Quantity <input type="number" name="qty" min="0" step="any" inputmode="decimal"></label>
    <label>Unit cost <input type="number" name="unitCost" min="0" step="any" inputmode="decimal"></label>
    <button type="button" class="btn small danger" data-remove title="Remove line">✕</button>
  </div>`;
}

function vReceive() {
  const sup = [...S.suppliers].sort((a, b) => a.name.localeCompare(b.name));
  const recent = [...S.receipts].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, 15);
  const sm = suppliersById();
  view.innerHTML = `
    <h1>Receive stock (GRN)</h1>
    <p class="sub">Record every delivery from MSD or a vendor. Each line creates a batch and a ledger entry.</p>
    ${itemDatalist()}
    <form class="panel" id="f" novalidate>
      <div data-error></div>
      <div class="grid">
        <label>Date received <input type="date" name="date" value="${M.today()}"></label>
        <label>Supplier
          <select name="supplierId">${sup.map((s) => `<option value="${s.id}">${esc(s.name)} (${esc(s.kind)})</option>`).join('')}</select>
          <button type="button" class="btn link" id="addSup">+ new supplier</button></label>
        <label>Invoice no <input name="invoiceNo"></label>
        <label>Delivery note no <input name="deliveryNo"></label>
        <label>Order / requisition no <input name="orderNo"></label>
        <label>Checked by (witness) <input name="checkedBy"></label>
      </div>
      <h2>Items received</h2>
      <div class="lines" id="lines">${receiveLine()}</div>
      <div class="actions" style="margin-top:8px">
        <button type="button" class="btn" id="addLine">+ Add line</button>
        <a class="btn link" href="#/items">Item not listed? Add it first</a>
      </div>
      <label style="margin-top:12px">Remarks <textarea name="remarks" rows="2"></textarea></label>
      <div class="actions"><button class="btn primary">Save GRN &amp; post to ledger</button></div>
    </form>
    <h2>Recent receipts</h2>
    ${table(['GRN', 'Date', 'Supplier', 'Invoice', 'Lines', 'Received by'], recent.map((r) => `
      <tr class="click" data-href="#/doc/grn/${r.id}"><td>${esc(r.grnNo)}</td><td>${esc(r.date)}</td>
      <td>${esc(sm.get(r.supplierId)?.name)}</td><td>${esc(r.invoiceNo)}</td><td>${r.lines.length}</td><td>${esc(r.receivedBy)}</td></tr>`))}`;

  const f = view.querySelector('#f');
  const lines = view.querySelector('#lines');
  view.querySelector('#addLine').onclick = () => lines.insertAdjacentHTML('beforeend', receiveLine());
  lines.addEventListener('click', (e) => {
    if (e.target.matches('[data-remove]') && lines.children.length > 1) e.target.closest('[data-line]').remove();
  });
  view.querySelector('#addSup').onclick = async () => {
    const name = prompt('Supplier name (e.g. MSD Mwanza Zone, ABC Pharma Ltd)');
    if (!name) return;
    const kind = prompt('Type: MSD, Vendor, Donor or Other facility', 'Vendor') || 'Vendor';
    await commit({ suppliers: [M.makeSupplier({ name, kind }, user())] });
    vReceive();
  };
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const fd = new FormData(f);
      const lineEls = [...lines.querySelectorAll('[data-line]')];
      const input = {
        date: fd.get('date'), supplierId: fd.get('supplierId'), invoiceNo: fd.get('invoiceNo'),
        deliveryNo: fd.get('deliveryNo'), orderNo: fd.get('orderNo'), checkedBy: fd.get('checkedBy'), remarks: fd.get('remarks'),
        lines: lineEls.filter((el) => el.querySelector('[name=item]').value.trim()).map((el, i) => {
          const v = (n) => el.querySelector(`[name=${n}]`).value;
          const item = resolveItem(v('item'));
          if (!item) throw new Error(`Line ${i + 1}: “${v('item')}” is not in the item list`);
          return { itemId: item.id, batchNo: v('batchNo'), expiry: v('expiry'), qty: v('qty'), unitCost: v('unitCost') };
        }),
      };
      const changes = M.receiveStock(S, input, user());
      await commit(changes);
      toast(`Saved ${changes.receipts[0].grnNo}`);
      go(`doc/grn/${changes.receipts[0].id}`);
    } catch (err) { showError(f, err); }
  });
  bindRowLinks();
}

// -------------------------------------------------------------- dispense

function batchOptions(itemId, { includeExpired = false, auto = true } = {}) {
  if (!itemId) return auto ? '<option value="">Auto (first expiry first)</option>' : '<option value="">—</option>';
  const bs = M.availableBatches(S, itemId).filter((b) => includeExpired || !b.expired);
  return (auto ? '<option value="">Auto (first expiry first)</option>' : '') +
    bs.map((b) => `<option value="${b.id}">${esc(b.batchNo)} · exp ${esc(b.expiry)} · ${fmt(b.balance)}${b.expired ? ' · EXPIRED' : ''}</option>`).join('');
}

function stockHint(item) {
  if (!item) return '';
  const bs = M.availableBatches(S, item.id);
  const usable = bs.filter((b) => !b.expired).reduce((s, b) => s + b.balance, 0);
  const cls = usable <= 0 ? 'bad' : item.reorderLevel && usable <= item.reorderLevel ? 'warn' : 'ok';
  return `${pill(`In stock: ${fmt(usable)} ${item.unit}`, cls)} ${item.controlled ? pill('Controlled', 'bad') : ''}`;
}

function dispenseLine() {
  return `<div class="line disp" data-line>
    <label class="wide">Medicine / item <input list="dl-items" name="item" autocomplete="off" placeholder="Type to search"><div class="hint" data-hint></div></label>
    <label>Quantity <input type="number" name="qty" min="0" step="any" inputmode="decimal"></label>
    <label>Dosage / directions <input name="dosage" placeholder="e.g. 1 tab 3×/day × 5 days"></label>
    <label>Batch <select name="batchId">${batchOptions(null)}</select></label>
    <button type="button" class="btn small danger" data-remove title="Remove line">✕</button>
  </div>`;
}

function vDispense() {
  view.innerHTML = `
    <h1>Dispense</h1>
    <p class="sub">Each prescription becomes one entry in the Dispensing Register and is deducted from the ledger automatically.</p>
    ${itemDatalist()}
    <form class="panel" id="f" novalidate>
      <div data-error></div>
      <div class="grid">
        <label>Date <input type="date" name="date" value="${M.today()}"></label>
        <label>Patient name * <input name="patientName" autocomplete="off"></label>
        <label>Patient ID / file no <input name="patientId" autocomplete="off"></label>
        <label>Age <input name="age" inputmode="numeric"></label>
        <label>Sex <select name="sex"><option></option><option>F</option><option>M</option></select></label>
        <label>Phone / address <input name="address"></label>
        <label>Prescriber <input name="prescriber"></label>
        <label>Prescription no <input name="rxNo"></label>
        <label>Diagnosis <input name="diagnosis"></label>
      </div>
      <h2>Items</h2>
      <div class="lines" id="lines">${dispenseLine()}</div>
      <div class="actions" style="margin-top:8px"><button type="button" class="btn" id="addLine">+ Add item</button></div>
      <div class="actions"><button class="btn primary">Save to register &amp; ledger</button></div>
    </form>`;
  const f = view.querySelector('#f');
  const lines = view.querySelector('#lines');
  view.querySelector('#addLine').onclick = () => lines.insertAdjacentHTML('beforeend', dispenseLine());
  lines.addEventListener('click', (e) => {
    if (e.target.matches('[data-remove]') && lines.children.length > 1) e.target.closest('[data-line]').remove();
  });
  lines.addEventListener('change', (e) => {
    if (!e.target.matches('[name=item]')) return;
    const el = e.target.closest('[data-line]');
    const item = resolveItem(e.target.value);
    el.querySelector('[data-hint]').innerHTML = item ? stockHint(item) : (e.target.value ? pill('Not in item list', 'bad') : '');
    el.querySelector('[name=batchId]').innerHTML = batchOptions(item?.id);
  });
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const fd = new FormData(f);
      const input = Object.fromEntries(['date', 'patientName', 'patientId', 'age', 'sex', 'address', 'prescriber', 'rxNo', 'diagnosis'].map((k) => [k, fd.get(k)]));
      input.lines = [...lines.querySelectorAll('[data-line]')].filter((el) => el.querySelector('[name=item]').value.trim()).map((el, i) => {
        const v = (n) => el.querySelector(`[name=${n}]`).value;
        const item = resolveItem(v('item'));
        if (!item) throw new Error(`Line ${i + 1}: “${v('item')}” is not in the item list`);
        return { itemId: item.id, qty: v('qty'), dosage: v('dosage'), batchId: v('batchId') };
      });
      const changes = M.dispense(S, input, user());
      await commit(changes);
      toast(`Saved ${changes.dispenses[0].serialNo}`);
      go(`doc/dispense/${changes.dispenses[0].id}`);
    } catch (err) { showError(f, err); }
  });
}

// ------------------------------------------------------ issue / adjust

const PARTY_LABEL = {
  ISSUE: 'Issued to (ward / unit / facility) *', RETURN_IN: 'Returned by (patient / ward)', RETURN_OUT: 'Returned to (supplier)',
  EXPIRED: 'Disposal / destruction ref', DAMAGED: 'Where / who', ADJUST_IN: 'Party', ADJUST_OUT: 'Party',
};

function vMovements({ params }) {
  const type = params.get('type') || 'ISSUE';
  const bm = batchesById();
  const im = itemsById();
  const recent = S.txns.filter((t) => M.MANUAL_TYPES.includes(t.type) && t.party !== 'Stock count')
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, 30);
  view.innerHTML = `
    <h1>Issue, return &amp; adjust</h1>
    <p class="sub">Movements that are not patient dispensing: issues to wards/units, returns, expiry and damage write-offs, and corrections.</p>
    ${itemDatalist()}
    <form class="panel" id="f" novalidate>
      <div data-error></div>
      <div class="grid">
        <label>Movement type <select name="type">${M.MANUAL_TYPES.map((t) => `<option value="${t}" ${t === type ? 'selected' : ''}>${esc(typeLabel(t))}</option>`).join('')}</select></label>
        <label>Date <input type="date" name="date" value="${M.today()}"></label>
        <label>Item <input list="dl-items" name="item" autocomplete="off"><div class="hint" data-hint></div></label>
        <label>Batch <select name="batchId">${batchOptions(null, { auto: false })}</select></label>
        <label>Quantity <input type="number" name="qty" min="0" step="any" inputmode="decimal"></label>
        <label><span data-party>${esc(PARTY_LABEL[type])}</span> <input name="party"></label>
        <label>Reference (issue voucher, note no) <input name="ref"></label>
        <label>Reason / remarks <input name="remarks"></label>
      </div>
      <div class="actions"><button class="btn primary">Post to ledger</button></div>
    </form>
    <h2>Recent movements</h2>
    ${table(['Date', 'Type', 'Item', 'Batch', ['Qty', 'num'], 'Party', 'Ref', 'By', 'Remarks'], recent.map((t) => `<tr>
      <td>${esc(t.date)}</td><td>${esc(typeLabel(t.type))}</td><td>${esc(M.itemLabel(im.get(t.itemId)))}</td>
      <td>${esc(bm.get(t.batchId)?.batchNo)}</td><td class="num ${t.qty > 0 ? 'in' : 'out'}">${fmt(t.qty)}</td>
      <td>${esc(t.party)}</td><td>${esc(t.ref)}</td><td>${esc(t.user)}</td><td>${esc(t.remarks)}</td></tr>`))}`;
  const f = view.querySelector('#f');
  // Look fields up by name: form.elements.item is a built-in method, not the "item" field.
  const fld = (n) => f.querySelector(`[name=${n}]`);
  const fe = { item: fld('item'), type: fld('type'), batchId: fld('batchId') };
  const refreshBatches = () => {
    const item = resolveItem(fe.item.value);
    const incoming = M.TXN_TYPES[fe.type.value].dir > 0;
    // Returns-in and positive adjustments may go to any batch the item ever had.
    fe.batchId.innerHTML = incoming && item
      ? S.batches.filter((b) => b.itemId === item.id).map((b) => `<option value="${b.id}">${esc(b.batchNo)} · exp ${esc(b.expiry)}</option>`).join('')
      : batchOptions(item?.id, { includeExpired: fe.type.value !== 'ISSUE', auto: false });
    view.querySelector('[data-hint]').innerHTML = stockHint(item);
  };
  fe.type.onchange = () => { view.querySelector('[data-party]').textContent = PARTY_LABEL[fe.type.value]; refreshBatches(); };
  fe.item.onchange = refreshBatches;
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const fd = new FormData(f);
      const changes = M.postMovement(S, Object.fromEntries(fd.entries()), user());
      await commit(changes);
      toast('Posted to ledger');
      vMovements({ params: new URLSearchParams({ type: fd.get('type') }) });
    } catch (err) { showError(f, err); }
  });
}

// ------------------------------------------------------------- stock take

function vStockTake({ params }) {
  const q = (params.get('q') || '').toLowerCase();
  const bb = M.batchBalances(S);
  const im = itemsById();
  const rows = S.batches
    .filter((b) => (bb.get(b.id) || 0) !== 0 && im.get(b.itemId)?.active !== false)
    .map((b) => ({ ...b, item: im.get(b.itemId), balance: bb.get(b.id) }))
    .filter((b) => !q || M.itemLabel(b.item).toLowerCase().includes(q) || (b.item?.category || '').toLowerCase().includes(q) || b.batchNo.toLowerCase().includes(q))
    .sort((a, b) => M.itemLabel(a.item).localeCompare(M.itemLabel(b.item)) || (a.expiry < b.expiry ? -1 : 1));
  view.innerHTML = `
    <h1>Stock take</h1>
    <p class="sub">Count what is on the shelf. Only differences are posted, as adjustments with the count recorded.</p>
    ${printHeader('Physical stock count sheet')}
    <form id="f" novalidate>
      <div data-error></div>
      <div class="toolbar">
        <label>Filter (item, category, batch) <input name="q" value="${esc(q)}" id="q"></label>
        <label>Count date <input type="date" name="date" value="${M.today()}"></label>
        <label>Reference <input name="ref" placeholder="e.g. Quarterly count Q3"></label>
        <label>Remarks <input name="remarks"></label>
      </div>
      ${table(['Item', 'Unit', 'Batch', 'Expiry', ['Ledger qty', 'num'], ['Counted', 'num']], rows.map((b) => `<tr>
        <td>${esc(M.itemLabel(b.item))}</td><td>${esc(b.item?.unit)}</td><td>${esc(b.batchNo)}</td>
        <td>${esc(b.expiry)} ${b.expiry < M.today() ? pill('expired', 'bad') : ''}</td><td class="num">${fmt(b.balance)}</td>
        <td class="num" style="width:120px"><input type="number" min="0" step="any" inputmode="decimal" data-batch="${b.id}"></td></tr>`),
        { empty: 'No stock on hand.' })}
      <div class="actions">
        <button class="btn primary">Post differences</button>
        <button type="button" class="btn" onclick="window.print()">Print count sheet</button>
      </div>
    </form>`;
  const f = view.querySelector('#f');
  view.querySelector('#q').onchange = (e) => go('stocktake', { q: e.target.value });
  view.querySelector('#q').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); go('stocktake', { q: e.target.value }); } };
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const fd = new FormData(f);
      const counts = [...f.querySelectorAll('[data-batch]')].map((i) => ({ batchId: i.dataset.batch, counted: i.value }));
      const changes = M.stockTake(S, { date: fd.get('date'), ref: fd.get('ref'), remarks: fd.get('remarks'), counts }, user());
      if (!changes.txns.length) { toast('No differences – nothing to post'); return; }
      if (!confirm(`${changes.txns.length} batch(es) differ from the ledger. Post adjustments?`)) return;
      await commit(changes);
      toast(`${changes.txns.length} adjustment(s) posted`);
      vStockTake({ params });
    } catch (err) { showError(f, err); }
  });
}

// ------------------------------------------------------------------ ledger

function vLedger({ params }) {
  const item = S.items.find((i) => i.id === params.get('item'));
  const from = params.get('from') || '';
  const to = params.get('to') || '';
  let body = '<p class="empty">Choose an item to open its stock card.</p>';
  let card = null;
  if (item) {
    card = M.stockCard(S, item.id, { from, to });
    const bs = M.availableBatches(S, item.id);
    body = `
      ${printHeader('Stock card (ledger)', `— ${esc(M.itemLabel(item))}`)}
      <div class="panel">
        <dl class="kv">
          <dt>Item</dt><dd><b>${esc(M.itemLabel(item))}</b> ${item.controlled ? pill('Controlled', 'bad') : ''}</dd>
          <dt>Code</dt><dd>${esc(item.code || '—')}</dd>
          <dt>Unit of issue</dt><dd>${esc(item.unit)}</dd>
          <dt>Re-order level</dt><dd>${fmt(item.reorderLevel) || '—'}</dd>
          <dt>Balance now</dt><dd><b>${fmt(bs.reduce((s, b) => s + b.balance, 0))}</b> ${esc(item.unit)}</dd>
        </dl>
        <h2>Batches in stock</h2>
        ${table(['Batch', 'Expiry', ['Balance', 'num'], ''], bs.map((b) => `<tr class="click" data-href="#/trace?batch=${b.id}">
          <td>${esc(b.batchNo)}</td><td>${esc(b.expiry)}</td><td class="num">${fmt(b.balance)}</td><td>${b.expired ? pill('expired', 'bad') : ''}</td></tr>`),
          { empty: 'No stock.' })}
      </div>
      ${table(['Date', 'Type', 'Ref', 'From / to', 'Batch', 'Expiry', ['In', 'num'], ['Out', 'num'], ['Balance', 'num'], 'By', 'Remarks'],
        (from ? [`<tr><td>${esc(from)}</td><td colspan="7"><i>Opening balance</i></td><td class="num"><b>${fmt(card.opening)}</b></td><td colspan="2"></td></tr>`] : []).concat(
        card.rows.map((r) => `<tr>
          <td>${esc(r.date)}</td><td>${esc(typeLabel(r.type))}</td>
          <td>${r.docId ? `<a href="#/doc/${r.type === 'RECEIPT' ? 'grn' : 'dispense'}/${r.docId}">${esc(r.ref)}</a>` : esc(r.ref)}</td>
          <td>${esc(r.party)}</td><td>${esc(r.batchNo)}</td><td>${esc(r.expiry)}</td>
          <td class="num in">${r.qtyIn ? fmt(r.qtyIn) : ''}</td><td class="num out">${r.qtyOut ? fmt(r.qtyOut) : ''}</td>
          <td class="num"><b>${fmt(r.balance)}</b></td><td>${esc(r.user)}</td><td>${esc(r.remarks)}</td></tr>`)),
        { empty: 'No movements in this period.',
          foot: `<tfoot><tr><td colspan="6">Closing balance</td><td class="num">${fmt(card.rows.reduce((s, r) => s + r.qtyIn, 0))}</td><td class="num">${fmt(card.rows.reduce((s, r) => s + r.qtyOut, 0))}</td><td class="num">${fmt(card.closing)}</td><td colspan="2"></td></tr></tfoot>` })}`;
  }
  view.innerHTML = `
    <h1>Ledger – stock card</h1>
    <p class="sub">Every movement of an item, with running balance. Entries cannot be edited or deleted.</p>
    ${itemDatalist()}
    <form class="toolbar" id="f">
      <label style="flex:3 1 260px">Item <input list="dl-items" name="item" autocomplete="off" value="${item ? esc(itemKey(item)) : ''}"></label>
      <label>From <input type="date" name="from" value="${esc(from)}"></label>
      <label>To <input type="date" name="to" value="${esc(to)}"></label>
      <button class="btn primary">Show</button>
      ${item ? '<button type="button" class="btn" id="csv">CSV</button><button type="button" class="btn" onclick="window.print()">Print</button>' : ''}
    </form>
    ${body}`;
  view.querySelector('#f').addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const it = resolveItem(fd.get('item'));
    if (!it) { toast('Choose an item from the list'); return; }
    go('ledger', { item: it.id, from: fd.get('from'), to: fd.get('to') });
  });
  const csv = view.querySelector('#csv');
  if (csv) csv.onclick = () => download(`stock-card-${item.code || item.name}-${M.today()}.csv`, M.toCsv(card.rows, [
    { label: 'Date', get: 'date' }, { label: 'Type', get: (r) => typeLabel(r.type) }, { label: 'Ref', get: 'ref' },
    { label: 'From/To', get: 'party' }, { label: 'Batch', get: 'batchNo' }, { label: 'Expiry', get: 'expiry' },
    { label: 'In', get: 'qtyIn' }, { label: 'Out', get: 'qtyOut' }, { label: 'Balance', get: 'balance' },
    { label: 'By', get: 'user' }, { label: 'Remarks', get: 'remarks' },
  ]));
  bindRowLinks();
}

// ---------------------------------------------------- dispensing register

function registerLines(d, im) {
  return d.lines.map((l) => `${esc(M.itemLabel(im.get(l.itemId)))} × <b>${fmt(l.qty)}</b>
    <span class="hint">${esc(l.allocations.map((a) => a.batchNo).join(', '))}${l.dosage ? ' · ' + esc(l.dosage) : ''}</span>`).join('<br>');
}

function vRegister({ params }) {
  const from = params.get('from') || monthStart();
  const to = params.get('to') || M.today();
  const q = params.get('q') || '';
  const controlledOnly = params.get('controlled') === '1';
  const rows = M.dispensingRegister(S, { from, to, q, controlledOnly });
  const im = itemsById();
  view.innerHTML = `
    <h1>Dispensing register</h1>
    <p class="sub">Every prescription dispensed, in order. Voided entries stay visible, struck through.</p>
    ${printHeader(controlledOnly ? 'Controlled medicines register' : 'Dispensing register', `${esc(from)} to ${esc(to)}`)}
    <form class="toolbar" id="f">
      <label>From <input type="date" name="from" value="${esc(from)}"></label>
      <label>To <input type="date" name="to" value="${esc(to)}"></label>
      <label style="flex:2 1 200px">Search (patient, ID, drug, prescriber, no.) <input name="q" value="${esc(q)}"></label>
      <label class="check"><input type="checkbox" name="controlled" value="1" ${controlledOnly ? 'checked' : ''}> Controlled only</label>
      <button class="btn primary">Show</button>
      <button type="button" class="btn" id="csv">CSV</button>
      <button type="button" class="btn" onclick="window.print()">Print</button>
    </form>
    ${table(['S/No', 'Date', 'Patient', 'ID', 'Age/Sex', 'Items dispensed', 'Prescriber / Rx', 'By', ''], rows.map((d) => `
      <tr class="click ${d.voided ? 'void' : ''}" data-href="#/doc/dispense/${d.id}">
        <td>${esc(d.serialNo)}</td><td>${esc(d.date)}</td><td>${esc(d.patientName)}</td><td>${esc(d.patientId)}</td>
        <td>${esc([d.age, d.sex].filter(Boolean).join('/'))}</td><td>${registerLines(d, im)}</td>
        <td>${esc(d.prescriber)}${d.rxNo ? '<br><span class="hint">Rx ' + esc(d.rxNo) + '</span>' : ''}</td>
        <td>${esc(d.dispensedBy)}</td><td>${d.voided ? pill('VOID', 'bad') : ''}</td></tr>`),
      { empty: 'No entries for this period.' })}
    <p class="hint">${rows.filter((d) => !d.voided).length} prescription(s), ${rows.filter((d) => d.voided).length} void.</p>`;
  view.querySelector('#f').addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    go('register', { from: fd.get('from'), to: fd.get('to'), q: fd.get('q'), controlled: fd.get('controlled') ? '1' : '' });
  });
  view.querySelector('#csv').onclick = () => {
    const flat = rows.flatMap((d) => d.lines.flatMap((l) => l.allocations.map((a) => ({ d, l, a }))));
    download(`dispensing-register-${from}-to-${to}.csv`, M.toCsv(flat, [
      { label: 'S/No', get: (r) => r.d.serialNo }, { label: 'Date', get: (r) => r.d.date },
      { label: 'Patient', get: (r) => r.d.patientName }, { label: 'Patient ID', get: (r) => r.d.patientId },
      { label: 'Age', get: (r) => r.d.age }, { label: 'Sex', get: (r) => r.d.sex },
      { label: 'Item', get: (r) => M.itemLabel(im.get(r.l.itemId)) }, { label: 'Batch', get: (r) => r.a.batchNo },
      { label: 'Expiry', get: (r) => r.a.expiry }, { label: 'Qty', get: (r) => r.a.qty }, { label: 'Dosage', get: (r) => r.l.dosage },
      { label: 'Prescriber', get: (r) => r.d.prescriber }, { label: 'Rx no', get: (r) => r.d.rxNo },
      { label: 'Diagnosis', get: (r) => r.d.diagnosis }, { label: 'Dispensed by', get: (r) => r.d.dispensedBy },
      { label: 'Status', get: (r) => (r.d.voided ? `VOID: ${r.d.voidReason}` : '') },
    ]));
  };
  bindRowLinks();
}

// ------------------------------------------------------------------- trace

function vTrace({ params }) {
  const tab = params.get('tab') || 'batch';
  const q = params.get('q') || '';
  const batchId = params.get('batch');
  const im = itemsById();
  let body = '';
  if (tab === 'patient') {
    const rows = M.patientHistory(S, q);
    body = q ? table(['Date', 'S/No', 'Patient', 'ID', 'Items', 'Prescriber'], rows.map((d) => `
      <tr class="click ${d.voided ? 'void' : ''}" data-href="#/doc/dispense/${d.id}"><td>${esc(d.date)}</td><td>${esc(d.serialNo)}</td>
      <td>${esc(d.patientName)}</td><td>${esc(d.patientId)}</td><td>${registerLines(d, im)}</td><td>${esc(d.prescriber)}</td></tr>`),
      { empty: 'No patient found.' }) : '';
  } else if (batchId) {
    const t = M.traceBatch(S, batchId);
    body = t ? traceChain(t) : '<div class="alert bad">Batch not found.</div>';
  } else if (q) {
    const bb = M.batchBalances(S);
    const res = M.findBatches(S, q);
    body = table(['Batch', 'Item', 'Expiry', 'Received', ['Balance', 'num']], res.map((b) => `
      <tr class="click" data-href="#/trace?batch=${b.id}"><td><b>${esc(b.batchNo)}</b></td><td>${esc(M.itemLabel(b.item))}</td>
      <td>${esc(b.expiry)}</td><td>${esc(b.receivedDate)}</td><td class="num">${fmt(bb.get(b.id) || 0)}</td></tr>`),
      { empty: 'No batch matches.' });
  }
  view.innerHTML = `
    <h1>Trace</h1>
    <p class="sub">Follow a batch from the supplier to every patient or unit that received it — or see everything a patient received.</p>
    <div class="tabs no-print">
      <a href="#/trace?tab=batch" class="${tab === 'batch' ? 'active' : ''}">By batch / item</a>
      <a href="#/trace?tab=patient" class="${tab === 'patient' ? 'active' : ''}">By patient</a>
    </div>
    <form class="toolbar" id="f">
      <label style="flex:3 1 260px">${tab === 'patient' ? 'Patient name or ID' : 'Batch number or item name'} <input name="q" value="${esc(q)}" autocomplete="off"></label>
      <button class="btn primary">Search</button>
      ${batchId ? '<button type="button" class="btn" onclick="window.print()">Print</button>' : ''}
    </form>
    ${body}`;
  view.querySelector('#f').addEventListener('submit', (e) => {
    e.preventDefault();
    go('trace', { tab, q: new FormData(e.target).get('q') });
  });
  const rc = view.querySelector('#recallCsv');
  if (rc) {
    const t = M.traceBatch(S, batchId);
    rc.onclick = () => download(`recall-${t.batch.batchNo}.csv`, M.toCsv(t.recipients, [
      { label: 'Date', get: 'date' }, { label: 'Type', get: (r) => typeLabel(r.type) }, { label: 'Ref', get: 'ref' },
      { label: 'Patient / unit', get: 'name' }, { label: 'Patient ID', get: 'patientId' }, { label: 'Contact', get: 'contact' },
      { label: 'Prescriber', get: 'prescriber' }, { label: 'Qty', get: 'qty' },
    ]));
  }
  bindRowLinks();
}

function traceChain(t) {
  const r = t.receipt;
  const received = t.movements.filter((m) => m.type === 'RECEIPT').reduce((s, m) => s + m.qty, 0);
  const out = t.recipients.reduce((s, x) => s + x.qty, 0);
  return `
    ${printHeader('Batch trace report', `— ${esc(M.itemLabel(t.item))} batch ${esc(t.batch.batchNo)}`)}
    <div class="chain">
      <div class="panel"><h2 style="margin-top:0">1 · Arrived</h2><dl class="kv">
        <dt>Item</dt><dd><b>${esc(M.itemLabel(t.item))}</b></dd>
        <dt>Batch</dt><dd><b>${esc(t.batch.batchNo)}</b></dd>
        <dt>Expiry</dt><dd>${esc(t.batch.expiry)} ${t.batch.expiry < M.today() ? pill('expired', 'bad') : ''}</dd>
        <dt>Supplier</dt><dd>${esc(t.supplier?.name || '—')}</dd>
        <dt>GRN</dt><dd>${r ? `<a href="#/doc/grn/${r.id}">${esc(r.grnNo)}</a>` : '—'}</dd>
        <dt>Date</dt><dd>${esc(t.batch.receivedDate)}</dd>
        <dt>Invoice</dt><dd>${esc(r?.invoiceNo || '—')}</dd>
        <dt>Delivery note</dt><dd>${esc(r?.deliveryNo || '—')}</dd>
        <dt>Received by</dt><dd>${esc(r?.receivedBy || '—')}${r?.checkedBy ? ' · checked ' + esc(r.checkedBy) : ''}</dd>
        <dt>Qty received</dt><dd>${fmt(received)} ${esc(t.item?.unit)}</dd>
      </dl></div>
      <div class="panel"><h2 style="margin-top:0">2 · Went out</h2><dl class="kv">
        <dt>To patients/units</dt><dd>${fmt(out)} ${esc(t.item?.unit)} in ${t.recipients.length} transaction(s)</dd>
        <dt>Other movements</dt><dd>${t.movements.filter((m) => !['RECEIPT', 'DISPENSE', 'ISSUE', 'REVERSAL'].includes(m.type)).length}</dd>
      </dl></div>
      <div class="panel"><h2 style="margin-top:0">3 · Left on shelf</h2><p style="font-size:28px;margin:0"><b>${fmt(t.balance)}</b> ${esc(t.item?.unit)}</p></div>
    </div>
    <h2>Recipients (recall list)</h2>
    ${table(['Date', 'Type', 'Ref', 'Patient / unit', 'Patient ID', 'Contact', 'Prescriber', ['Qty', 'num']], t.recipients.map((x) => `<tr>
      <td>${esc(x.date)}</td><td>${esc(typeLabel(x.type))}</td><td>${esc(x.ref)}</td><td>${esc(x.name)}</td>
      <td>${esc(x.patientId)}</td><td>${esc(x.contact)}</td><td>${esc(x.prescriber)}</td><td class="num">${fmt(x.qty)}</td></tr>`),
      { empty: 'Nobody has received this batch yet.' })}
    <div class="actions no-print"><button class="btn" id="recallCsv">Export recall list (CSV)</button></div>
    <h2>Full movement history</h2>
    ${table(['Date', 'Type', 'Ref', 'Party', ['Qty', 'num'], ['Balance', 'num'], 'By', 'Remarks'], t.movements.map((m) => `<tr>
      <td>${esc(m.date)}</td><td>${esc(typeLabel(m.type))}</td><td>${esc(m.ref)}</td><td>${esc(m.party)}</td>
      <td class="num ${m.qty > 0 ? 'in' : 'out'}">${fmt(m.qty)}</td><td class="num">${fmt(m.balance)}</td><td>${esc(m.user)}</td><td>${esc(m.remarks)}</td></tr>`))}`;
}

// ----------------------------------------------------------------- reports

function vReports({ params }) {
  const tab = params.get('tab') || 'status';
  const im = itemsById();
  let body = '';
  let csv = null;
  const tabs = [['status', 'Stock status'], ['expiry', 'Expiry'], ['order', 'Order / requisition'], ['summary', 'Movement summary']];

  if (tab === 'status') {
    const months = Number(params.get('months')) || 3;
    const rows = M.stockStatus(S, { months }).sort((a, b) => M.itemLabel(a.item).localeCompare(M.itemLabel(b.item)));
    const total = rows.reduce((s, r) => s + r.value, 0);
    body = `
      <form class="toolbar" data-params><label>Average consumption over <select name="months">${[1, 3, 6, 12].map((m) => `<option value="${m}" ${m === months ? 'selected' : ''}>${m} month(s)</option>`).join('')}</select></label><button class="btn">Update</button></form>
      ${table(['Item', 'Unit', ['On hand', 'num'], ['Expired', 'num'], ['≤90 days', 'num'], ['Value', 'num'], ['AMC', 'num'], ['Months of stock', 'num'], 'Next expiry', 'Status'],
        rows.map((r) => `<tr class="click" data-href="#/ledger?item=${r.item.id}"><td>${esc(M.itemLabel(r.item))}</td><td>${esc(r.item.unit)}</td>
        <td class="num">${fmt(r.onHand)}</td><td class="num">${r.expired ? fmt(r.expired) : ''}</td><td class="num">${r.nearExpiry ? fmt(r.nearExpiry) : ''}</td>
        <td class="num">${money(r.value)}</td><td class="num">${fmt(r.amc)}</td><td class="num">${r.monthsOfStock === null ? '—' : fmt(r.monthsOfStock)}</td>
        <td>${esc(r.nextExpiry)}</td><td>${r.stockOut ? pill('Stock-out', 'bad') : r.belowReorder ? pill('Re-order', 'warn') : pill('OK', 'ok')}</td></tr>`),
        { foot: `<tfoot><tr><td colspan="5">Total value</td><td class="num">${money(total)}</td><td colspan="4"></td></tr></tfoot>` })}`;
    csv = () => download(`stock-status-${M.today()}.csv`, M.toCsv(rows, [
      { label: 'Code', get: (r) => r.item.code }, { label: 'Item', get: (r) => M.itemLabel(r.item) }, { label: 'Unit', get: (r) => r.item.unit },
      { label: 'On hand', get: 'onHand' }, { label: 'Expired', get: 'expired' }, { label: 'Expiring <=90d', get: 'nearExpiry' },
      { label: 'Value', get: (r) => r.value.toFixed(2) }, { label: 'AMC', get: (r) => r.amc.toFixed(2) },
      { label: 'Months of stock', get: (r) => (r.monthsOfStock === null ? '' : r.monthsOfStock.toFixed(1)) },
      { label: 'Next expiry', get: 'nextExpiry' }, { label: 'Re-order level', get: (r) => r.item.reorderLevel },
    ]));
  } else if (tab === 'expiry') {
    const days = Number(params.get('days')) || 180;
    const rows = M.expiryReport(S, { days });
    body = `
      <form class="toolbar" data-params><label>Expiring within <select name="days">${[30, 90, 180, 365].map((d) => `<option value="${d}" ${d === days ? 'selected' : ''}>${d} days</option>`).join('')}</select></label><button class="btn">Update</button></form>
      ${table(['Item', 'Batch', 'Expiry', ['Days left', 'num'], ['Qty', 'num'], ['Value', 'num'], 'Supplier'], rows.map((b) => `
        <tr class="click" data-href="#/trace?batch=${b.id}"><td>${esc(M.itemLabel(b.item))}</td><td>${esc(b.batchNo)}</td><td>${esc(b.expiry)}</td>
        <td class="num">${b.daysLeft < 0 ? pill('expired', 'bad') : b.daysLeft}</td><td class="num">${fmt(b.balance)}</td><td class="num">${money(b.value)}</td>
        <td>${esc(suppliersById().get(b.supplierId)?.name)}</td></tr>`),
        { empty: 'Nothing expiring in this window.', foot: rows.length ? `<tfoot><tr><td colspan="5">Value at risk</td><td class="num">${money(rows.reduce((s, b) => s + b.value, 0))}</td><td></td></tr></tfoot>` : '' })}`;
    csv = () => download(`expiry-${days}d-${M.today()}.csv`, M.toCsv(rows, [
      { label: 'Item', get: (r) => M.itemLabel(r.item) }, { label: 'Batch', get: 'batchNo' }, { label: 'Expiry', get: 'expiry' },
      { label: 'Days left', get: 'daysLeft' }, { label: 'Qty', get: 'balance' }, { label: 'Value', get: (r) => r.value.toFixed(2) },
    ]));
  } else if (tab === 'order') {
    const cover = Number(params.get('cover')) || 3;
    const rows = M.stockStatus(S, { months: 3, targetMonths: cover })
      .filter((r) => r.suggestedOrder > 0 || r.belowReorder || r.stockOut)
      .sort((a, b) => M.itemLabel(a.item).localeCompare(M.itemLabel(b.item)));
    body = `
      <form class="toolbar" data-params><label>Order to cover <select name="cover">${[1, 2, 3, 4, 6].map((m) => `<option value="${m}" ${m === cover ? 'selected' : ''}>${m} month(s)</option>`).join('')}</select></label><button class="btn">Update</button></form>
      <p class="hint">Suggested quantity = average monthly consumption (last 3 months) × months to cover − usable stock. Adjust before sending to MSD.</p>
      ${table(['Code', 'Item', 'Unit', ['Usable stock', 'num'], ['AMC', 'num'], ['Months of stock', 'num'], ['Suggested order', 'num']], rows.map((r) => `<tr>
        <td>${esc(r.item.code)}</td><td>${esc(M.itemLabel(r.item))}</td><td>${esc(r.item.unit)}</td><td class="num">${fmt(r.usable)}</td>
        <td class="num">${fmt(r.amc)}</td><td class="num">${r.monthsOfStock === null ? '—' : fmt(r.monthsOfStock)}</td><td class="num"><b>${fmt(r.suggestedOrder)}</b></td></tr>`),
        { empty: 'Nothing needs ordering.' })}
      <div class="signs print-only"><div>Prepared by (Pharmacist in charge)</div><div>Approved by</div><div>Date</div></div>`;
    csv = () => download(`requisition-${M.today()}.csv`, M.toCsv(rows, [
      { label: 'Code', get: (r) => r.item.code }, { label: 'Item', get: (r) => M.itemLabel(r.item) }, { label: 'Unit', get: (r) => r.item.unit },
      { label: 'Usable stock', get: 'usable' }, { label: 'AMC', get: (r) => r.amc.toFixed(2) }, { label: 'Suggested order', get: 'suggestedOrder' },
    ]));
  } else {
    const from = params.get('from') || monthStart();
    const to = params.get('to') || M.today();
    const sums = new Map();
    for (const t of S.txns) {
      if (t.date < from || t.date > to) continue;
      const row = sums.get(t.itemId) || { RECEIPT: 0, DISPENSE: 0, ISSUE: 0, RETURN_IN: 0, RETURN_OUT: 0, LOSS: 0, ADJ: 0 };
      if (t.type === 'EXPIRED' || t.type === 'DAMAGED') row.LOSS += -t.qty;
      else if (t.type === 'ADJUST_IN' || t.type === 'ADJUST_OUT') row.ADJ += t.qty;
      else if (t.type === 'REVERSAL') row.DISPENSE -= t.qty; // voided dispenses net out
      else if (t.type in row) row[t.type] += Math.abs(t.qty);
      sums.set(t.itemId, row);
    }
    const rows = [...sums.entries()].map(([id, r]) => ({ item: im.get(id), ...r, opening: M.stockCard(S, id, { from }).opening }))
      .map((r) => ({ ...r, closing: r.opening + r.RECEIPT + r.RETURN_IN - r.DISPENSE - r.ISSUE - r.RETURN_OUT - r.LOSS + r.ADJ }))
      .sort((a, b) => M.itemLabel(a.item).localeCompare(M.itemLabel(b.item)));
    body = `
      <form class="toolbar" data-params><label>From <input type="date" name="from" value="${esc(from)}"></label><label>To <input type="date" name="to" value="${esc(to)}"></label><button class="btn">Update</button></form>
      ${printHeader('Movement summary', `${esc(from)} to ${esc(to)}`)}
      ${table(['Item', ['Opening', 'num'], ['Received', 'num'], ['Returned in', 'num'], ['Dispensed', 'num'], ['Issued', 'num'], ['Returned out', 'num'], ['Expired/lost', 'num'], ['Adjust ±', 'num'], ['Closing', 'num']],
        rows.map((r) => `<tr class="click" data-href="#/ledger?item=${r.item?.id}&from=${from}&to=${to}"><td>${esc(M.itemLabel(r.item))}</td><td class="num">${fmt(r.opening)}</td>
        <td class="num">${fmt(r.RECEIPT)}</td><td class="num">${fmt(r.RETURN_IN)}</td><td class="num">${fmt(r.DISPENSE)}</td><td class="num">${fmt(r.ISSUE)}</td>
        <td class="num">${fmt(r.RETURN_OUT)}</td><td class="num">${fmt(r.LOSS)}</td><td class="num">${fmt(r.ADJ)}</td><td class="num"><b>${fmt(r.closing)}</b></td></tr>`),
        { empty: 'No movements in this period.' })}`;
    csv = () => download(`movement-summary-${from}-to-${to}.csv`, M.toCsv(rows, [
      { label: 'Item', get: (r) => M.itemLabel(r.item) }, { label: 'Opening', get: 'opening' }, { label: 'Received', get: 'RECEIPT' },
      { label: 'Returned in', get: 'RETURN_IN' }, { label: 'Dispensed', get: 'DISPENSE' }, { label: 'Issued', get: 'ISSUE' },
      { label: 'Returned out', get: 'RETURN_OUT' }, { label: 'Expired/lost', get: 'LOSS' }, { label: 'Adjustments', get: 'ADJ' }, { label: 'Closing', get: 'closing' },
    ]));
  }

  const title = tabs.find((t) => t[0] === tab)[1];
  view.innerHTML = `
    <h1>Reports</h1>
    <p class="sub">Tap a row to open its stock card or trace.</p>
    <div class="tabs no-print">${tabs.map(([k, l]) => `<a href="#/reports?tab=${k}" class="${k === tab ? 'active' : ''}">${l}</a>`).join('')}</div>
    ${tab !== 'summary' ? printHeader(title) : ''}
    ${body}
    <div class="actions"><button class="btn" id="csv">Export CSV</button><button class="btn" onclick="window.print()">Print</button></div>`;
  const pf = view.querySelector('[data-params]');
  if (pf) pf.addEventListener('submit', (e) => { e.preventDefault(); go('reports', { tab, ...Object.fromEntries(new FormData(pf).entries()) }); });
  view.querySelector('#csv').onclick = csv;
  bindRowLinks();
}

// ---------------------------------------------------- items & suppliers

function vItems({ params }) {
  const editing = S.items.find((i) => i.id === params.get('id')) || null;
  const editSup = S.suppliers.find((s) => s.id === params.get('sup')) || null;
  const q = (params.get('q') || '').toLowerCase();
  const ib = M.itemBalances(S);
  const items = S.items.filter((i) => !q || itemKey(i).toLowerCase().includes(q) || (i.category || '').toLowerCase().includes(q))
    .sort((a, b) => M.itemLabel(a).localeCompare(M.itemLabel(b)));
  const e = editing || { unit: '', active: true };
  const cats = [...new Set(S.items.map((i) => i.category).filter(Boolean))];
  view.innerHTML = `
    <h1>Items &amp; suppliers</h1>
    <p class="sub">Master list of medicines and supplies, and where they come from.</p>
    <form class="panel" id="fi" novalidate>
      <h2 style="margin-top:0">${editing ? 'Edit item' : 'Add item'}</h2>
      <div data-error></div>
      <div class="grid">
        <label>Generic name * <input name="name" value="${esc(e.name)}" placeholder="e.g. Amoxicillin"></label>
        <label>Strength <input name="strength" value="${esc(e.strength)}" placeholder="e.g. 250mg"></label>
        <label>Dosage form <input name="form" value="${esc(e.form)}" placeholder="e.g. Capsule" list="dl-forms"></label>
        <label>Unit of issue * <input name="unit" value="${esc(e.unit)}" placeholder="e.g. caps, bottle, vial" list="dl-units"></label>
        <label>Item / MSD code <input name="code" value="${esc(e.code)}"></label>
        <label>Category <input name="category" value="${esc(e.category)}" list="dl-cats" placeholder="e.g. Antibiotics"></label>
        <label>Re-order level <input type="number" name="reorderLevel" min="0" step="any" value="${esc(e.reorderLevel || '')}"></label>
      </div>
      <div class="actions" style="margin-top:10px">
        <label class="check"><input type="checkbox" name="controlled" ${e.controlled ? 'checked' : ''}> Controlled medicine (narcotic / psychotropic)</label>
        ${editing ? `<label class="check"><input type="checkbox" name="active" ${e.active !== false ? 'checked' : ''}> Active</label>` : ''}
      </div>
      <datalist id="dl-forms">${['Tablet', 'Capsule', 'Syrup', 'Suspension', 'Injection', 'Infusion', 'Cream', 'Ointment', 'Eye drops', 'Inhaler', 'Suppository', 'Sachet', 'Device'].map((x) => `<option value="${x}">`).join('')}</datalist>
      <datalist id="dl-units">${['tab', 'caps', 'bottle', 'vial', 'amp', 'tube', 'sachet', 'piece', 'pack', 'kit'].map((x) => `<option value="${x}">`).join('')}</datalist>
      <datalist id="dl-cats">${cats.map((x) => `<option value="${esc(x)}">`).join('')}</datalist>
      <div class="actions">
        <button class="btn primary">${editing ? 'Save changes' : 'Add item'}</button>
        ${editing ? '<a class="btn" href="#/items">Cancel</a>' : ''}
        <label class="btn" style="margin-left:auto">Import items from CSV<input type="file" accept=".csv,text/csv" id="csvIn" hidden></label>
      </div>
      <p class="hint">CSV columns: name, strength, form, unit, code, category, reorderLevel, controlled (yes/no). First row is the header.</p>
    </form>
    <form class="toolbar" id="fs"><label>Search items <input name="q" value="${esc(q)}"></label><button class="btn">Search</button></form>
    ${table(['Code', 'Item', 'Unit', 'Category', ['Re-order', 'num'], ['Balance', 'num'], ''], items.map((i) => `
      <tr class="click" data-href="#/items?id=${i.id}"><td>${esc(i.code)}</td><td>${esc(M.itemLabel(i))}</td><td>${esc(i.unit)}</td>
      <td>${esc(i.category)}</td><td class="num">${fmt(i.reorderLevel) || ''}</td><td class="num">${fmt(ib.get(i.id) || 0)}</td>
      <td>${i.controlled ? pill('Controlled', 'bad') : ''} ${i.active === false ? pill('Inactive') : ''}</td></tr>`),
      { empty: 'No items yet – add your first item above.' })}

    <h2>Suppliers</h2>
    <form class="panel" id="fsup" novalidate>
      <div data-error></div>
      <div class="grid">
        <label>Name <input name="name" value="${esc(editSup?.name)}" placeholder="e.g. MSD Dar es Salaam Zone"></label>
        <label>Type <select name="kind">${['MSD', 'Vendor', 'Donor', 'Other facility', 'Other'].map((k) => `<option ${editSup?.kind === k ? 'selected' : ''}>${k}</option>`).join('')}</select></label>
        <label>Contact <input name="contact" value="${esc(editSup?.contact)}"></label>
      </div>
      <div class="actions"><button class="btn primary">${editSup ? 'Save supplier' : 'Add supplier'}</button>${editSup ? '<a class="btn" href="#/items">Cancel</a>' : ''}</div>
    </form>
    ${table(['Supplier', 'Type', 'Contact', ['Deliveries', 'num']], [...S.suppliers].sort((a, b) => a.name.localeCompare(b.name)).map((s) => `
      <tr class="click" data-href="#/items?sup=${s.id}"><td>${esc(s.name)}</td><td>${esc(s.kind)}</td><td>${esc(s.contact)}</td>
      <td class="num">${S.receipts.filter((r) => r.supplierId === s.id).length}</td></tr>`))}`;

  const fi = view.querySelector('#fi');
  fi.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      const fd = new FormData(fi);
      const input = { ...(editing || {}), ...Object.fromEntries(fd.entries()), controlled: fd.has('controlled'), active: editing ? fd.has('active') : true };
      const dup = S.items.find((i) => i.id !== input.id && M.itemLabel(i).toLowerCase() === M.itemLabel({ name: input.name.trim(), strength: input.strength.trim(), form: input.form.trim() }).toLowerCase());
      if (dup && !confirm(`${M.itemLabel(dup)} already exists. Add anyway?`)) return;
      await commit({ items: [M.makeItem(input, user())] });
      toast(editing ? 'Item updated' : 'Item added');
      go('items');
      if (!editing) vItems({ params: new URLSearchParams() });
    } catch (err) { showError(fi, err); }
  });
  view.querySelector('#fs').addEventListener('submit', (ev) => { ev.preventDefault(); go('items', { q: new FormData(ev.target).get('q') }); });
  view.querySelector('#csvIn').addEventListener('change', async (ev) => {
    const file = ev.target.files[0];
    if (!file) return;
    try {
      const recs = parseCsv(await file.text());
      const existing = new Set(S.items.map((i) => M.itemLabel(i).toLowerCase()));
      const add = [];
      for (const r of recs) {
        if (!r.name) continue;
        const it = M.makeItem({ ...r, controlled: /^(y|yes|true|1)$/i.test(r.controlled || '') }, user());
        if (existing.has(M.itemLabel(it).toLowerCase())) continue;
        existing.add(M.itemLabel(it).toLowerCase());
        add.push(it);
      }
      await commit({ items: add });
      toast(`Imported ${add.length} item(s)`);
      vItems({ params: new URLSearchParams() });
    } catch (err) { showError(fi, err); }
  });
  const fsup = view.querySelector('#fsup');
  fsup.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      const fd = new FormData(fsup);
      await commit({ suppliers: [M.makeSupplier({ ...(editSup || {}), ...Object.fromEntries(fd.entries()) }, user())] });
      toast('Supplier saved');
      go('items');
      if (!editSup) vItems({ params: new URLSearchParams() });
    } catch (err) { showError(fsup, err); }
  });
  bindRowLinks();
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows.filter((r) => r.some((c) => c.trim()));
  if (!head) return [];
  const keys = head.map((h) => h.trim().replace(/\s+/g, '').replace(/^reorder(level)?$/i, 'reorderLevel').toLowerCase());
  const norm = { reorderlevel: 'reorderLevel' };
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [norm[k] || k, (r[i] || '').trim()])));
}

// --------------------------------------------------------------- documents

function vDoc({ parts }) {
  const [, kind, id] = parts;
  const im = itemsById();
  if (kind === 'grn') {
    const r = S.receipts.find((x) => x.id === id);
    if (!r) { view.innerHTML = '<div class="alert bad">GRN not found.</div>'; return; }
    const sup = suppliersById().get(r.supplierId);
    const total = r.lines.reduce((s, l) => s + l.qty * (l.unitCost || 0), 0);
    view.innerHTML = `
      <div class="panel">
        <div class="doc-head"><div><h1>Goods Received Note</h1><div>${esc(S.settings.facility)}</div></div>
          <div style="text-align:right"><b>${esc(r.grnNo)}</b><br>${esc(r.date)}</div></div>
        <dl class="kv">
          <dt>Supplier</dt><dd>${esc(sup?.name)} (${esc(sup?.kind)})</dd>
          <dt>Invoice no</dt><dd>${esc(r.invoiceNo || '—')}</dd>
          <dt>Delivery note</dt><dd>${esc(r.deliveryNo || '—')}</dd>
          <dt>Order no</dt><dd>${esc(r.orderNo || '—')}</dd>
          ${r.remarks ? `<dt>Remarks</dt><dd>${esc(r.remarks)}</dd>` : ''}
        </dl>
        <h2>Items</h2>
        ${table(['#', 'Item', 'Unit', 'Batch', 'Expiry', ['Qty', 'num'], ['Unit cost', 'num'], ['Value', 'num']], r.lines.map((l, i) => `<tr>
          <td>${i + 1}</td><td>${esc(M.itemLabel(im.get(l.itemId)))}</td><td>${esc(im.get(l.itemId)?.unit)}</td>
          <td><a href="#/trace?batch=${l.batchId}">${esc(l.batchNo)}</a></td><td>${esc(l.expiry)}</td>
          <td class="num">${fmt(l.qty)}</td><td class="num">${money(l.unitCost)}</td><td class="num">${money(l.qty * (l.unitCost || 0))}</td></tr>`),
          { foot: `<tfoot><tr><td colspan="7">Total</td><td class="num">${money(total)}</td></tr></tfoot>` })}
        <div class="signs"><div>Received by: ${esc(r.receivedBy)}</div><div>Checked by: ${esc(r.checkedBy)}</div><div>Supplier's representative</div></div>
      </div>
      <div class="actions"><button class="btn primary" onclick="window.print()">Print GRN</button><a class="btn" href="#/receive">New receipt</a></div>`;
    return;
  }
  const d = S.dispenses.find((x) => x.id === id);
  if (!d) { view.innerHTML = '<div class="alert bad">Register entry not found.</div>'; return; }
  view.innerHTML = `
    <div class="panel">
      ${d.voided ? `<div class="alert bad">VOID — ${esc(d.voidReason)} (by ${esc(d.voidedBy)}, ${esc(d.voidedAt?.slice(0, 10))}). Stock was returned to the ledger.</div>` : ''}
      <div class="doc-head"><div><h1>Dispensing record</h1><div>${esc(S.settings.facility)}</div></div>
        <div style="text-align:right"><b>${esc(d.serialNo)}</b><br>${esc(d.date)}</div></div>
      <dl class="kv">
        <dt>Patient</dt><dd><b>${esc(d.patientName)}</b> ${d.patientId ? '· ID ' + esc(d.patientId) : ''} ${[d.age, d.sex].filter(Boolean).length ? '· ' + esc([d.age, d.sex].filter(Boolean).join('/')) : ''}</dd>
        ${d.address ? `<dt>Contact</dt><dd>${esc(d.address)}</dd>` : ''}
        <dt>Prescriber</dt><dd>${esc(d.prescriber || '—')} ${d.rxNo ? '· Rx ' + esc(d.rxNo) : ''}</dd>
        ${d.diagnosis ? `<dt>Diagnosis</dt><dd>${esc(d.diagnosis)}</dd>` : ''}
      </dl>
      <h2>Items</h2>
      ${table(['Item', ['Qty', 'num'], 'Directions', 'Batch (expiry)'], d.lines.map((l) => `<tr>
        <td>${esc(M.itemLabel(im.get(l.itemId)))}</td><td class="num">${fmt(l.qty)} ${esc(im.get(l.itemId)?.unit)}</td><td>${esc(l.dosage)}</td>
        <td>${l.allocations.map((a) => `<a href="#/trace?batch=${a.batchId}">${esc(a.batchNo)}</a> (${esc(a.expiry)}) × ${fmt(a.qty)}`).join('<br>')}</td></tr>`))}
      <div class="signs"><div>Dispensed by: ${esc(d.dispensedBy)}</div><div>Received by (patient / carer)</div></div>
    </div>
    <div class="actions">
      <button class="btn primary" onclick="window.print()">Print</button>
      <a class="btn" href="#/dispense">Next patient</a>
      <a class="btn" href="#/register">Register</a>
      ${d.voided ? '' : '<button class="btn danger" id="void">Void entry…</button>'}
    </div>`;
  const vb = view.querySelector('#void');
  if (vb) vb.onclick = async () => {
    const reason = prompt('Reason for voiding (recorded permanently):');
    if (!reason) return;
    try {
      await commit(M.voidDispense(S, d.id, reason, user()));
      toast('Entry voided – stock returned');
      render();
    } catch (err) { alert(err.message); }
  };
}

// ---------------------------------------------------------------- settings

function vSettings() {
  const staff = S.settings.staff || [];
  const counts = M.COLLECTIONS.map((c) => `${c}: ${S[c].length}`).join(' · ');
  view.innerHTML = `
    <h1>Settings &amp; sync</h1>
    <form class="panel" id="fs">
      <h2 style="margin-top:0">This device</h2>
      <div class="grid">
        <label>Facility name <input name="facility" value="${esc(S.settings.facility)}"></label>
        <label>Current user <input name="currentUser" list="dl-staff" value="${esc(user())}"></label>
        <label>Device code <input name="deviceCode" value="${esc(S.settings.deviceCode)}" maxlength="4"></label>
        <label>Theme <select name="theme">${['auto', 'light', 'dark'].map((t) => `<option ${S.settings.theme === t ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      </div>
      <datalist id="dl-staff">${staff.map((s) => `<option value="${esc(s)}">`).join('')}</datalist>
      <p class="hint">Every entry records the current user. Switch user here when handing over a shift.</p>
      <div class="actions"><button class="btn primary">Save</button></div>
    </form>

    <div class="panel">
      <h2 style="margin-top:0">Backup &amp; move data between devices</h2>
      <p>Data lives on this device only. Back up regularly, and use the same file to copy records between your Android phone/tablet and Linux PC. Importing <b>merges</b> — nothing already here is lost or duplicated.</p>
      <p class="hint">Last backup: ${esc(S.settings.lastBackup ? new Date(S.settings.lastBackup).toLocaleString() : 'never')} · ${esc(counts)}</p>
      <div class="actions">
        <button class="btn primary" id="exp">Export backup (.json)</button>
        <label class="btn">Import / merge backup<input type="file" id="imp" accept=".json,application/json" hidden></label>
      </div>
      <div id="impResult"></div>
    </div>

    <div class="panel" id="srv">
      <h2 style="margin-top:0">Office sync server</h2>
      <p class="hint">Checking…</p>
    </div>

    <div class="panel">
      <h2 style="margin-top:0">Danger zone</h2>
      <p>Erase all data on this device. Export a backup first.</p>
      <button class="btn danger" id="wipe">Erase this device…</button>
    </div>`;

  view.querySelector('#fs').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const cu = fd.get('currentUser').trim();
    if (!cu) { toast('Current user is required'); return; }
    await setSetting('facility', fd.get('facility').trim());
    await setSetting('currentUser', cu);
    await setSetting('deviceCode', fd.get('deviceCode').trim().toUpperCase().replace(/[^A-Z0-9]/g, '') || 'D1');
    await setSetting('theme', fd.get('theme'));
    if (!staff.includes(cu)) await setSetting('staff', [...staff, cu]);
    applyTheme();
    toast('Settings saved');
    render();
  });
  view.querySelector('#exp').onclick = async () => {
    const data = Object.fromEntries(M.COLLECTIONS.map((c) => [c, S[c]]));
    const payload = { app: 'pharmacy-ledger', version: 1, exportedAt: M.nowIso(), facility: S.settings.facility, device: S.settings.deviceCode, data };
    download(`pharmacy-backup-${S.settings.deviceCode || 'D1'}-${M.today()}.json`, JSON.stringify(payload), 'application/json');
    await setSetting('lastBackup', M.nowIso());
    toast('Backup downloaded');
  };
  view.querySelector('#imp').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const out = view.querySelector('#impResult');
    try {
      const payload = JSON.parse(await file.text());
      if (payload.app !== 'pharmacy-ledger' || !payload.data) throw new Error('This is not a Pharmacy Ledger backup file');
      const changes = mergeIncoming(payload.data);
      await commit(changes);
      out.innerHTML = `<div class="alert ok">Merged from ${esc(payload.device || '?')} (${esc(payload.exportedAt?.slice(0, 10))}): ${esc(summary(changes))}</div>`;
    } catch (err) {
      out.innerHTML = `<div class="alert bad">${esc(err.message)}</div>`;
    }
  });
  view.querySelector('#wipe').onclick = async () => {
    if (prompt('Type ERASE to delete all data on this device') !== 'ERASE') return;
    await DB.wipeAll();
    S = M.emptyState();
    location.hash = '#/dashboard';
    render();
  };
  renderServerPanel();
}

function mergeIncoming(data) {
  const changes = {};
  for (const c of M.COLLECTIONS) changes[c] = M.mergeCollection(S[c], data[c] || []).changed;
  return changes;
}

function summary(changes) {
  const parts = M.COLLECTIONS.filter((c) => changes[c]?.length).map((c) => `${changes[c].length} ${c}`);
  return parts.length ? parts.join(', ') + ' added/updated' : 'already up to date';
}

// ------------------------------------------------------------ server sync
// When the app is opened from the office PC's server (python3 server.py),
// devices on the same network sync through it automatically.

let serverOk = null;
let syncTimer = null;
let syncing = false;

let serverInfo = null;

const syncHeaders = () => ({ 'Content-Type': 'application/json', 'X-Sync-Key': S.settings.syncKey || '' });

async function pingServer() {
  serverInfo = null;
  try {
    const r = await fetch('api/ping', { cache: 'no-store', headers: syncHeaders() });
    const body = r.ok ? await r.json() : {};
    if (body.app === 'pharmacy-ledger') serverInfo = body;
  } catch { /* opened from a file or a static host: no server */ }
  serverOk = !!(serverInfo && serverInfo.authorised);
  return serverOk;
}

async function syncNow() {
  if (syncing) return null;
  syncing = true;
  try {
    const started = M.nowIso();
    const since = S.settings.lastPushAt || '';
    const records = {};
    for (const c of M.COLLECTIONS) records[c] = S[c].filter((r) => (r.updatedAt || '') > since);
    const res = await fetch('api/sync', {
      method: 'POST', headers: syncHeaders(),
      body: JSON.stringify({ device: S.settings.deviceCode, since: S.settings.serverSeq || 0, records }),
    });
    if (!res.ok) throw new Error(`Server replied ${res.status}`);
    const body = await res.json();
    const changes = mergeIncoming(body.records || {});
    await DB.saveChanges(changes);
    S = M.applyChanges(S, changes);
    await setSetting('serverSeq', body.seq);
    await setSetting('lastPushAt', started);
    await setSetting('lastServerSync', M.nowIso());
    // Show other devices' entries on read-only screens; never wipe a half-filled form.
    const readOnly = ['dashboard', 'ledger', 'register', 'trace', 'reports'].includes(route().parts[0]);
    if (readOnly && M.COLLECTIONS.some((c) => changes[c]?.length)) render();
    return changes;
  } finally { syncing = false; }
}

function scheduleSync() {
  if (!serverOk) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncNow().catch((e) => console.warn('sync failed', e)), 400);
}

async function renderServerPanel() {
  const el = view.querySelector('#srv');
  if (!el) return;
  const ok = await pingServer();
  if (!view.contains(el)) return;
  if (serverInfo && !ok) {
    el.innerHTML = `<h2 style="margin-top:0">Office sync server</h2>
      <p>${pill('Sync key needed', 'warn')} The office server is protected. Enter the key it was started with.</p>
      <form class="toolbar" id="fk"><label>Sync key <input name="key" type="password" autocomplete="off"></label><button class="btn primary">Connect</button></form>`;
    el.querySelector('#fk').addEventListener('submit', async (e) => {
      e.preventDefault();
      await setSetting('syncKey', new FormData(e.target).get('key'));
      if (await pingServer()) {
        await syncNow().catch((err) => toast(err.message));
        toast('Connected to office server');
      } else toast('Wrong sync key');
      renderServerPanel();
    });
    return;
  }
  if (!ok) {
    el.innerHTML = `<h2 style="margin-top:0">Office sync server</h2>
      <p>Not connected. To keep several devices in one live system, run <code>python3 server.py</code> on the office Linux PC and open
      <code>http://&lt;PC-address&gt;:8765</code> on each device on the same Wi‑Fi. Until then, use backup files to move data.</p>`;
    return;
  }
  el.innerHTML = `<h2 style="margin-top:0">Office sync server</h2>
    <p>${pill('Connected', 'ok')} This device syncs automatically after every save and every few minutes.</p>
    <p class="hint">Last sync: ${esc(S.settings.lastServerSync ? new Date(S.settings.lastServerSync).toLocaleString() : 'never')}</p>
    <div class="actions"><button class="btn primary" id="syncBtn">Sync now</button></div><div id="syncOut"></div>`;
  el.querySelector('#syncBtn').onclick = async () => {
    try {
      const ch = await syncNow();
      el.querySelector('#syncOut').innerHTML = `<div class="alert ok">${esc(ch ? summary(ch) : 'Sync already running')}</div>`;
    } catch (err) {
      el.querySelector('#syncOut').innerHTML = `<div class="alert bad">${esc(err.message)}</div>`;
    }
  };
}

// ------------------------------------------------------------------- boot

function bindRowLinks() {
  for (const tr of view.querySelectorAll('tr[data-href]')) {
    tr.addEventListener('click', (e) => { if (!e.target.closest('a,button,input')) location.hash = tr.dataset.href; });
  }
}

function applyTheme() {
  const t = S.settings.theme;
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}

async function boot() {
  try {
    S = await DB.loadState();
  } catch (e) {
    view.innerHTML = `<div class="alert bad">Cannot open local storage: ${esc(e.message)}. Private/incognito windows are not supported.</div>`;
    return;
  }
  applyTheme();
  window.addEventListener('hashchange', render);
  render();
  DB.requestPersistence();
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW registration failed', e));
  }
  if ((await pingServer()) || serverInfo) {
    const pull = async () => {
      if (!serverOk) return;
      try { await syncNow(); } catch (e) { console.warn('sync failed', e); }
    };
    pull();
    setInterval(pull, 3 * 60 * 1000);
  }
}

boot();
