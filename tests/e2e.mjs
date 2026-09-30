// End-to-end check in a real browser: a Linux PC and an Android-sized phone
// work against the office server as one system.
//   npm run e2e          (uses a local or global Playwright install)
import { execSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pw;
try { pw = await import('playwright'); } catch {
  pw = createRequire(import.meta.url)(join(execSync('npm root -g').toString().trim(), 'playwright'));
}
const { chromium, devices } = pw;

const PORT = 8799;
const URL = `http://localhost:${PORT}/`;
const data = mkdtempSync(join(tmpdir(), 'pl-e2e-'));
const server = spawn('python3', ['server.py', '--port', String(PORT), '--host', '127.0.0.1', '--data', data, '--key', 'k1'], { stdio: 'inherit' });
const errors = [];
let browser;

function check(cond, msg) {
  if (!cond) throw new Error('FAILED: ' + msg);
  console.log('  ✓ ' + msg);
}

async function device(name, opts) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${name}: ${m.text()}`); });
  page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? (d.message().includes('Reason') ? 'Wrong patient' : '') : undefined));
  await page.goto(URL);
  return page;
}

async function setup(page, who, code) {
  await page.fill('[name=facility]', 'Test Health Centre');
  await page.fill('[name=currentUser]', who);
  await page.fill('[name=deviceCode]', code);
  await page.click('text=Start');
  await page.waitForSelector('h1:text("Ledger")');
  await page.goto(URL + '#/settings');
  await page.fill('#fk [name=key]', 'k1');
  await page.click('#fk button');
  await page.waitForSelector('text=Connected');
}

try {
  await new Promise((r) => setTimeout(r, 800));
  browser = await chromium.launch();

  console.log('PC: setup, items, receive');
  const pc = await device('pc', { viewport: { width: 1280, height: 900 } });
  await setup(pc, 'Pharm. Asha', 'PC1');
  await pc.goto(URL + '#/items');
  for (const [name, strength, form, unit, reorder, controlled] of [
    ['Amoxicillin', '250mg', 'Capsule', 'caps', '200', false],
    ['Morphine', '10mg/ml', 'Injection', 'amp', '', true],
  ]) {
    await pc.fill('#fi [name=name]', name);
    await pc.fill('#fi [name=strength]', strength);
    await pc.fill('#fi [name=form]', form);
    await pc.fill('#fi [name=unit]', unit);
    await pc.fill('#fi [name=reorderLevel]', reorder);
    if (controlled) await pc.check('#fi [name=controlled]');
    await pc.click('#fi button.primary');
    await pc.waitForSelector(`td:text("${name} ${strength} ${form}")`);
  }
  check(await pc.locator('tbody tr').count() >= 2, 'items added');

  await pc.goto(URL + '#/receive');
  await pc.selectOption('[name=supplierId]', { label: 'MSD (MSD)' });
  await pc.fill('[name=invoiceNo]', 'MSD-INV-77');
  const l1 = pc.locator('[data-line]').nth(0);
  await l1.locator('[name=item]').fill('Amoxicillin 250mg Capsule');
  await l1.locator('[name=batchNo]').fill('am01');
  await l1.locator('[name=expiry]').fill('2027-06-30');
  await l1.locator('[name=qty]').fill('100');
  await l1.locator('[name=unitCost]').fill('50');
  await pc.click('#addLine');
  const l2 = pc.locator('[data-line]').nth(1);
  await l2.locator('[name=item]').fill('Amoxicillin 250mg Capsule');
  await l2.locator('[name=batchNo]').fill('AM00');
  await l2.locator('[name=expiry]').fill('2027-01-31');
  await l2.locator('[name=qty]').fill('40');
  await pc.click('#addLine');
  const l3 = pc.locator('[data-line]').nth(2);
  await l3.locator('[name=item]').fill('Morphine 10mg/ml Injection');
  await l3.locator('[name=batchNo]').fill('MO5');
  await l3.locator('[name=expiry]').fill('2027-03-01');
  await l3.locator('[name=qty]').fill('10');
  await pc.click('text=Save GRN');
  await pc.waitForSelector('h1:text("Goods Received Note")');
  check(await pc.isVisible('text=GRN-PC1-'), 'GRN created with device-prefixed number');

  console.log('PC: dispense form, FEFO');
  await pc.goto(URL + '#/dispense');
  await pc.fill('[name=patientName]', 'Neema Juma');
  await pc.fill('[name=patientId]', 'OPD-1001');
  const d1 = pc.locator('[data-line]').nth(0);
  await d1.locator('[name=item]').fill('Morphine 10mg/ml Injection');
  await d1.locator('[name=item]').dispatchEvent('change');
  await d1.locator('[name=qty]').fill('2');
  const formFields = await pc.$$eval('#f input[name], #f select[name]', (els) => els.map((e) => e.name).filter((n) => !['item', 'qty', 'dosage', 'batchId'].includes(n)));
  check(formFields.join() === 'date,patientName,patientId', `dispense form asks only date, patient name, ID/file no (got ${formFields.join()})`);
  await pc.click('#addLine');
  const d2 = pc.locator('[data-line]').nth(1);
  await d2.locator('[name=item]').fill('Amoxicillin 250mg Capsule');
  await d2.locator('[name=item]').dispatchEvent('change');
  check((await d2.locator('[data-hint]').innerText()).includes('140'), 'stock hint shows 140 caps');
  await d2.locator('[name=qty]').fill('50');
  await d2.locator('[name=dosage]').fill('2 caps tds x 5/7');
  await pc.click('text=Save to register');
  await pc.waitForSelector('h1:text("Dispensing record")');
  const slip = await pc.locator('main').innerText();
  check(/AM00.*× 40/s.test(slip) && /AM01.*× 10/s.test(slip), 'FEFO split: 40 from AM00 then 10 from AM01');

  await pc.waitForTimeout(1500); // let the PC's background sync push its saves
  console.log('Phone: sync, dispense, void');
  const phone = await device('phone', { ...devices['Pixel 7'] });
  await setup(phone, 'Tech. Baraka', 'TAB1');
  await phone.goto(URL + '#/register');
  await phone.waitForSelector('td:text("Neema Juma")');
  check(true, 'phone sees PC dispensing after sync');
  await phone.goto(URL + '#/dispense');
  await phone.fill('[name=patientName]', 'Juma Ally');
  const p1 = phone.locator('[data-line]').nth(0);
  await p1.locator('[name=item]').fill('Amoxicillin 250mg Capsule');
  await p1.locator('[name=item]').dispatchEvent('change');
  await p1.locator('[name=qty]').fill('15');
  await phone.click('text=Save to register');
  await phone.waitForSelector('h1:text("Dispensing record")');
  check(await phone.isVisible('text=DR-TAB1-'), 'phone register number uses its device code');
  await phone.click('#void');
  await phone.waitForSelector('text=VOID');
  check(true, 'voided entry kept and marked VOID');
  const hasHScroll = await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check(!hasHScroll, 'no horizontal page scroll on phone');
  await phone.goto(URL + '#/settings');
  await phone.click('#syncBtn');
  await phone.waitForSelector('#syncOut .alert');

  console.log('PC: ledger and register reflect both devices');
  await pc.goto(URL + '#/settings');
  await pc.click('#syncBtn');
  await pc.waitForSelector('#syncOut .alert');
  const amox = await pc.evaluate(() => indexedDB.databases());
  check(amox.length > 0, 'IndexedDB in use');
  await pc.goto(URL + '#/ledger');
  await pc.fill('#f [name=item]', 'Amoxicillin 250mg Capsule');
  await pc.click('#f button.primary');
  await pc.waitForSelector('tfoot');
  const foot = await pc.locator('table').last().locator('tfoot').innerText();
  // in = 140 received + 15 returned by the void reversal; out = 50 (PC) + 15 (phone)
  check(/155\s+65\s+90/.test(foot.replace(/,/g, '')), `stock card totals in 155 / out 65 / balance 90 (got "${foot.trim()}")`);
  const status = await (await fetch(URL + 'api/status', { headers: { 'X-Sync-Key': 'k1' } })).json();
  check(status.records.suppliers === 2, 'default suppliers not duplicated across devices');
  const card = await pc.locator('main').innerText();
  check(card.includes('GRN-PC1-') && card.includes('Neema Juma') && card.includes('AM01'), 'stock card shows GRN, patient and batch for tracing');
  const navText = await pc.locator('#nav').innerText();
  check(!/Dashboard|Trace|Reports|Stock take/.test(navText), 'only Ledger and Dispensing register in the menu');
  await pc.goto(URL + '#/register?controlled=1&from=2000-01-01');
  check(await pc.locator('tbody tr').count() === 1, 'controlled-only register filter');
  await pc.goto(URL + '#/movements');
  await pc.selectOption('#f [name=type]', 'ISSUE');
  await pc.fill('#f [name=item]', 'Amoxicillin 250mg Capsule');
  await pc.locator('#f [name=item]').dispatchEvent('change');
  await pc.fill('#f [name=qty]', '5');
  await pc.fill('#f [name=party]', 'Ward 2');
  await pc.click('text=Post to ledger');
  await pc.waitForSelector('td:text("Ward 2")');
  check(true, 'issue to ward posted');
  await pc.goto(URL + '#/ledger');
  await pc.screenshot({ path: join(process.env.SHOTS || data, 'pc-ledger.png'), fullPage: true });
  await phone.goto(URL + '#/dispense');
  await phone.screenshot({ path: join(process.env.SHOTS || data, 'phone-dispense.png'), fullPage: true });

  check(errors.length === 0, 'no browser errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  console.log('\nE2E PASSED');
} catch (e) {
  console.error(e.message);
  if (errors.length) console.error('Browser errors:', errors);
  process.exitCode = 1;
} finally {
  await browser?.close();
  server.kill();
  if (!process.env.SHOTS) rmSync(data, { recursive: true, force: true });
}
