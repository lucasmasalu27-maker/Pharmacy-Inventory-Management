// IndexedDB persistence. Data stays on the device (phone or PC) and works
// fully offline. Each collection is an object store keyed by `id`.
import { COLLECTIONS, emptyState } from './model.js';

const DB_NAME = 'pharmacy-ledger';
const DB_VERSION = 1;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const c of COLLECTIONS) if (!db.objectStoreNames.contains(c)) db.createObjectStore(c, { keyPath: 'id' });
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  });
}

function getAll(store) {
  return new Promise((resolve, reject) => {
    const r = store.getAll();
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export async function loadState() {
  const db = await open();
  const tx = db.transaction([...COLLECTIONS, 'settings'], 'readonly');
  const state = emptyState();
  await Promise.all(COLLECTIONS.map(async (c) => { state[c] = await getAll(tx.objectStore(c)); }));
  for (const s of await getAll(tx.objectStore('settings'))) state.settings[s.key] = s.value;
  return state;
}

// Write every record in `changes` ({collection: [records]}) in ONE atomic
// transaction, so a dispense and its ledger entries are saved together or
// not at all.
export async function saveChanges(changes) {
  const names = COLLECTIONS.filter((c) => changes[c] && changes[c].length);
  if (!names.length) return;
  const db = await open();
  const tx = db.transaction(names, 'readwrite');
  for (const c of names) for (const r of changes[c]) tx.objectStore(c).put(r);
  await done(tx);
}

export async function saveSetting(key, value) {
  const db = await open();
  const tx = db.transaction('settings', 'readwrite');
  tx.objectStore('settings').put({ key, value });
  await done(tx);
}

export async function wipeAll() {
  const db = await open();
  const tx = db.transaction([...COLLECTIONS, 'settings'], 'readwrite');
  for (const c of [...COLLECTIONS, 'settings']) tx.objectStore(c).clear();
  await done(tx);
}

// Ask the browser not to evict our data under storage pressure.
export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist();
  } catch { /* not supported */ }
  return false;
}
