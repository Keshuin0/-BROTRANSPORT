const DB_NAME = 'BROP_Offline_OS_DB';
const DB_VERSION = 2;
const MAX_RETRIES = 5;

export type QueueSubmissionKind =
  | 'carrier_application'
  | 'driver_document'
  | 'dvir'
  | 'stop_update'
  | 'ebol_signature';

export interface QueuedSubmission {
  id?: number;
  kind: QueueSubmissionKind;
  endpoint: string;
  payload: Record<string, unknown>;
  fileBlob?: Blob;
  fileName?: string;
  status: 'pending' | 'syncing' | 'failed_permanent';
  retryCount: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function isBrowserIdbAvailable(): boolean {
  return typeof window !== 'undefined' && typeof indexedDB !== 'undefined';
}

/** Singleton cached IndexedDB connection — never opens a new handle per keystroke! */
function getDb(): Promise<IDBDatabase> {
  if (!isBrowserIdbAvailable()) {
    return Promise.reject(new Error('IndexedDB is unavailable in this environment.'));
  }
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onerror = () => {
        dbPromise = null;
        reject(req.error);
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        resolve(db);
      };
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('drafts')) {
          db.createObjectStore('drafts', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('submissionQueue')) {
          db.createObjectStore('submissionQueue', { keyPath: 'id', autoIncrement: true });
        }
      };
    });
  }
  return dbPromise;
}

export async function saveDraft<T extends Record<string, unknown>>(key: string, data: T): Promise<void> {
  if (!isBrowserIdbAvailable()) return;
  try {
    const db = await getDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('drafts', 'readwrite');
      tx.objectStore('drafts').put({ key, data, updatedAt: Date.now() });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn('[offlineDb] saveDraft failed:', err);
  }
}

export async function getDraft<T>(key: string): Promise<T | null> {
  if (!isBrowserIdbAvailable()) return null;
  try {
    const db = await getDb();
    return await new Promise<T | null>((resolve, reject) => {
      const tx = db.transaction('drafts', 'readonly');
      const req = tx.objectStore('drafts').get(key);
      req.onsuccess = () => resolve(req.result ? (req.result.data as T) : null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

export async function clearDraft(key: string): Promise<void> {
  if (!isBrowserIdbAvailable()) return;
  try {
    const db = await getDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('drafts', 'readwrite');
      tx.objectStore('drafts').delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // ignore
  }
}

export async function enqueueOfflineSubmission(
  item: Omit<QueuedSubmission, 'id' | 'status' | 'retryCount' | 'createdAt' | 'updatedAt'>,
): Promise<number> {
  const db = await getDb();
  const now = Date.now();
  const record: QueuedSubmission = {
    ...item,
    status: 'pending',
    retryCount: 0,
    createdAt: now,
    updatedAt: now,
  };
  return new Promise<number>((resolve, reject) => {
    const tx = db.transaction('submissionQueue', 'readwrite');
    const req = tx.objectStore('submissionQueue').add(record);
    req.onsuccess = () => {
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('bro:offline-queue-updated'));
      }
      resolve(req.result as number);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function listOfflineQueue(): Promise<QueuedSubmission[]> {
  if (!isBrowserIdbAvailable()) return [];
  try {
    const db = await getDb();
    return await new Promise<QueuedSubmission[]>((resolve, reject) => {
      const tx = db.transaction('submissionQueue', 'readonly');
      const req = tx.objectStore('submissionQueue').getAll();
      req.onsuccess = () => resolve((req.result as QueuedSubmission[]) || []);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

export async function updateQueuedSubmission(item: QueuedSubmission): Promise<void> {
  const db = await getDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('submissionQueue', 'readwrite');
    tx.objectStore('submissionQueue').put({ ...item, updatedAt: Date.now() });
    tx.oncomplete = () => {
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('bro:offline-queue-updated'));
      }
      resolve();
    };
    tx.onerror = () => reject(tx.error);
  });
}

export async function removeQueuedSubmission(id: number): Promise<void> {
  const db = await getDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('submissionQueue', 'readwrite');
    tx.objectStore('submissionQueue').delete(id);
    tx.oncomplete = () => {
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('bro:offline-queue-updated'));
      }
      resolve();
    };
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Flushes pending offline submissions cleanly when network returns.
 * Distinguishes network timeouts (retry up to MAX_RETRIES) from 400/403 rejections
 * (marked `failed_permanent` so rejected fraud/invalid items NEVER loop forever!).
 */
export async function flushOfflineQueue(): Promise<{ synced: number; failedPermanent: number; remaining: number }> {
  if (typeof navigator === 'undefined' || !navigator.onLine) {
    const q = await listOfflineQueue();
    return { synced: 0, failedPermanent: 0, remaining: q.length };
  }

  const queue = await listOfflineQueue();
  let synced = 0;
  let failedPermanent = 0;

  for (const item of queue) {
    if (item.status === 'failed_permanent' || item.id === undefined) continue;

    try {
      await updateQueuedSubmission({ ...item, status: 'syncing' });
      let res: Response;

      if (item.fileBlob) {
        const fd = new FormData();
        fd.append('file', item.fileBlob, item.fileName || 'scan.webp');
        for (const [k, v] of Object.entries(item.payload)) {
          if (v !== undefined && v !== null) fd.append(k, String(v));
        }
        res = await fetch(item.endpoint, { method: 'POST', body: fd });
      } else {
        res = await fetch(item.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(item.payload),
        });
      }

      if (res.ok) {
        await removeQueuedSubmission(item.id);
        synced++;
      } else if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
        const errBody = (await res.json().catch(() => ({}))) as { error?: string };
        await updateQueuedSubmission({
          ...item,
          status: 'failed_permanent',
          lastError: errBody.error || `Server rejected (${res.status})`,
        });
        failedPermanent++;
      } else {
        const nextRetries = item.retryCount + 1;
        await updateQueuedSubmission({
          ...item,
          status: nextRetries >= MAX_RETRIES ? 'failed_permanent' : 'pending',
          retryCount: nextRetries,
          lastError: `HTTP ${res.status}`,
        });
      }
    } catch (err) {
      const nextRetries = item.retryCount + 1;
      await updateQueuedSubmission({
        ...item,
        status: nextRetries >= MAX_RETRIES ? 'failed_permanent' : 'pending',
        retryCount: nextRetries,
        lastError: err instanceof Error ? err.message : 'Network unavailable',
      });
    }
  }

  const remaining = (await listOfflineQueue()).length;
  return { synced, failedPermanent, remaining };
}
