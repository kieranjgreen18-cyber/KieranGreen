// A local-file image (dragged or pasted from the user's computer) has no
// citable URL, so the app keeps the actual image bytes around for the
// thumbnail and for re-download — but that can easily be several MB, and
// localStorage's ~5-10MB total quota (shared with everything else the app
// persists) isn't a safe place for that. IndexedDB has no such practical
// ceiling and is built for exactly this, so local-file image bytes live
// here, keyed by source id; state.js/localStorage only ever holds the
// lightweight metadata fields.
//
// Every function here is best-effort and never throws outward — a person
// who never drags in a local file, or whose browser blocks IndexedDB (rare,
// but private-browsing modes sometimes do), should never see this as an
// app-breaking error. Losing a locally-stored thumbnail on refresh is a
// minor inconvenience, not data loss of anything citable.

const DB_NAME = "citer";
const DB_VERSION = 1;
const STORE = "image-files";

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("indexeddb_unavailable"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

/** Stores a File/Blob under a source id. Resolves to true/false — never throws. */
export async function storeImageFile(id, file) {
  try {
    const db = await openDb();
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(file, id);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  } catch {
    return false;
  }
}

/** Returns the stored Blob for a source id, or null if there isn't one / it can't be read. */
export async function getImageFile(id) {
  try {
    const db = await openDb();
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function deleteImageFile(id) {
  try {
    const db = await openDb();
    await new Promise((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    /* best effort */
  }
}

export async function clearAllImageFiles() {
  try {
    const db = await openDb();
    await new Promise((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    /* best effort */
  }
}
