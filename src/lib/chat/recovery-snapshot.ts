const PREFIX = "previously-idb:";
const versions = new Map<string, symbol>();
type StorageView = Pick<Storage, "getItem" | "setItem">;

let opening: Promise<IDBDatabase> | undefined;
function database(): Promise<IDBDatabase> {
  if (!opening) opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("previously-chat-recovery", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("snapshots");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); opening = undefined; };
      resolve(db);
    };
  }).catch(error => { opening = undefined; throw error; });
  return opening;
}

async function snapshot(id: string, action: "read" | "write" | "remove", value?: string): Promise<string | null> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("snapshots", action === "read" ? "readonly" : "readwrite");
    const store = transaction.objectStore("snapshots");
    const request = action === "read" ? store.get(id) : action === "remove" ? store.delete(id) : store.put(value, id);
    transaction.oncomplete = () => resolve(action === "read" && typeof request.result === "string" ? request.result : null);
    transaction.onabort = transaction.onerror = () => reject(transaction.error);
  });
}

function discardPointer(value: string | null) {
  if (value?.startsWith(PREFIX)) void snapshot(value, "remove").catch(() => {});
}

export function readRecoverySnapshot(storage: StorageView, key: string): string | null | Promise<string | null> {
  const raw = storage.getItem(key);
  return raw?.startsWith(PREFIX) ? snapshot(raw, "read") : raw;
}

/** Keep ordinary snapshots immediately readable by older clients. When the
 * browser rejects a large write, publish a compact pointer only after IndexedDB
 * commits the complete replacement. Superseded writes cannot revive old data. */
export function writeRecoverySnapshot(storage: StorageView, key: string, value: string): void {
  const generation = Symbol();
  versions.set(key, generation);
  const previous = storage.getItem(key);
  try {
    storage.setItem(key, value);
    discardPointer(previous);
  } catch (error) {
    if (typeof indexedDB === "undefined") throw error;
    const id = PREFIX + crypto.randomUUID();
    void snapshot(id, "write", value).then(() => {
      if (versions.get(key) !== generation || storage.getItem(key) !== previous) return discardPointer(id);
      storage.setItem(key, id);
      discardPointer(previous);
    }).catch(() => {
      discardPointer(id);
      console.warn("[chat/recovery] Browser storage could not save the latest snapshot");
    });
  }
}

export function removeRecoverySnapshot(storage: Storage, key: string): void {
  versions.delete(key);
  const previous = storage.getItem(key);
  storage.removeItem(key);
  discardPointer(previous);
}
