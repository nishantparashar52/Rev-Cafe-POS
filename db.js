// IndexedDB persistence for the product catalogue.
const STORE = 'products';
let dbp;
const open = () => dbp ??= new Promise((res, rej) => {
  const r = indexedDB.open('revcafe', 1);
  r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
async function tx(mode, fn) {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => res(req?.result);
    t.onerror = () => rej(t.error);
  });
}
export const getAll = () => tx('readonly', s => s.getAll());
export const save = p => tx('readwrite', s => s.put(p));
export const remove = id => tx('readwrite', s => s.delete(id));
export const replaceAll = list => tx('readwrite', s => { s.clear(); list.forEach(p => s.put(p)); });
