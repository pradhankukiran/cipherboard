/**
 * Persist non-extractable CryptoKeys via IndexedDB structured cloning.
 */

const DB_NAME = "cipherboard-keys";
const DB_VERSION = 1;
const STORE = "identities";

export type StoredIdentity = {
  roomId: string;
  participantId: string;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  publicKeySpkiB64: string;
  fingerprint: string;
  displayName: string;
  sessionToken: string;
  role: string;
  inviteCode?: string;
  epoch: number;
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () =>
      reject(req.error ?? new Error("IndexedDB open failed"));
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "roomId" });
      }
    };
    req.onsuccess = () => resolve(req.result);
  });
}

export async function saveIdentity(identity: StoredIdentity): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("save failed"));
      tx.objectStore(STORE).put(identity);
    });
    db.close();
  } catch (e) {
    throw new Error(
      `Could not persist keys in IndexedDB. Session keys remain in memory only. (${String(e)})`,
    );
  }
}

export async function loadIdentity(
  roomId: string,
): Promise<StoredIdentity | null> {
  try {
    const db = await openDb();
    const result = await new Promise<StoredIdentity | null>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(roomId);
      req.onsuccess = () => resolve((req.result as StoredIdentity) ?? null);
      req.onerror = () => reject(req.error ?? new Error("load failed"));
    });
    db.close();
    return result;
  } catch {
    return null;
  }
}

export async function deleteIdentity(roomId: string): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("delete failed"));
      tx.objectStore(STORE).delete(roomId);
    });
    db.close();
  } catch {
    // ignore
  }
}

export async function supportsStructuredCloneKeys(): Promise<boolean> {
  try {
    const pair = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"],
    );
    const db = await openDb();
    const testId = "__probe__";
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.objectStore(STORE).put({
        roomId: testId,
        participantId: "probe",
        privateKey: pair.privateKey,
        publicKey: pair.publicKey,
        publicKeySpkiB64: "",
        fingerprint: "",
        displayName: "",
        sessionToken: "",
        role: "",
        epoch: 0,
      });
    });
    const loaded = await new Promise<StoredIdentity | null>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(testId);
      req.onsuccess = () => resolve((req.result as StoredIdentity) ?? null);
      req.onerror = () => reject(req.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.objectStore(STORE).delete(testId);
    });
    db.close();
    return !!loaded?.privateKey && loaded.privateKey instanceof CryptoKey;
  } catch {
    return false;
  }
}
