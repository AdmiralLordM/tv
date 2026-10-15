// The player's game files, kept in IndexedDB so they are asked for once.
// Each POD is stored whole as a Blob; files are read by slicing it, so the
// archives never have to sit in memory in full.
const DB_NAME = "terminal-velocity";
const STORE = "files";

function open() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run(mode, fn) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const result = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(result.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export function saveFile(name, blob) {
  return run("readwrite", (store) => store.put(blob, name.toLowerCase()));
}

export function loadFile(name) {
  return run("readonly", (store) => store.get(name.toLowerCase()));
}

export function forgetFiles() {
  return run("readwrite", (store) => store.clear());
}

// Ask the browser not to evict the files under storage pressure.
export async function keepFiles() {
  try {
    return await navigator.storage?.persist?.();
  } catch {
    return false;
  }
}
