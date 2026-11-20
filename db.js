// IndexedDB persistence: product catalogue + placed orders + raw materials + daily backups.
let dbp;
const open = () => dbp ??= new Promise((res, rej) => {
  const r = indexedDB.open('revcafe', 4);  // bumped to 4 to add backups store
  r.onupgradeneeded = () => {
    for (const s of ['products', 'orders', 'materials', 'backups'])
      if (!r.result.objectStoreNames.contains(s))
        r.result.createObjectStore(s, { keyPath: 'id', autoIncrement: s !== 'backups' });
  };
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => res(req?.result);
    t.onerror = () => rej(t.error);
  });
}
export const getAll = () => tx('products', 'readonly', s => s.getAll());
export const save = p => tx('products', 'readwrite', s => s.put(p));
export const remove = id => tx('products', 'readwrite', s => s.delete(id));
export const replaceAll = list => tx('products', 'readwrite', s => { s.clear(); list.forEach(p => s.put(p)); });
export const getOrders = () => tx('orders', 'readonly', s => s.getAll());
export const saveOrder = o => tx('orders', 'readwrite', s => s.put(o));
export const removeOrder = id => tx('orders', 'readwrite', s => s.delete(id));
// Raw materials
export const getMaterials = () => tx('materials', 'readonly', s => s.getAll());
export const saveMaterial = m => tx('materials', 'readwrite', s => s.put(m));
export const removeMaterial = id => tx('materials', 'readwrite', s => s.delete(id));
export const replaceAllMaterials = list => tx('materials', 'readwrite', s => { s.clear(); list.forEach(m => s.put(m)); });
// Daily backups — keyed by date string 'YYYY-MM-DD'
export const saveBackup = b => tx('backups', 'readwrite', s => s.put(b));
export const getBackup = id => tx('backups', 'readonly', s => s.get(id));
export const getAllBackups = () => tx('backups', 'readonly', s => s.getAll());
