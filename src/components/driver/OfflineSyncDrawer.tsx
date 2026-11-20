import React, { useState, useEffect, useCallback } from 'react';
import { Wifi, WifiOff, RefreshCw, Trash2, AlertTriangle, CloudUpload, X } from 'lucide-react';
import {
  listOfflineQueue,
  flushOfflineQueue,
  removeQueuedSubmission,
  type QueuedSubmission,
} from '../../lib/offlineDb';

export default function OfflineSyncDrawer() {
  const [online, setOnline] = useState(true);
  const [items, setItems] = useState<QueuedSubmission[]>([]);
  const [open, setOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const refresh = useCallback(async () => {
    const q = await listOfflineQueue();
    setItems(q);
  }, []);

  const handleSyncNow = useCallback(async () => {
    setSyncing(true);
    try {
      await flushOfflineQueue();
      await refresh();
    } finally {
      setSyncing(false);
    }
  }, [refresh]);

  useEffect(() => {
    setOnline(navigator.onLine);
    void refresh();

    const onOnline = () => {
      setOnline(true);
      void handleSyncNow();
    };
    const onOffline = () => setOnline(false);
    const onQueueChange = () => void refresh();

    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    window.addEventListener('bro:offline-queue-updated', onQueueChange);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('bro:offline-queue-updated', onQueueChange);
    };
  }, [refresh, handleSyncNow]);

  const pendingCount = items.filter((i) => i.status !== 'failed_permanent').length;
  const failedCount = items.filter((i) => i.status === 'failed_permanent').length;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full border font-mono text-[11px] transition-colors cursor-pointer ${
          !online
            ? 'bg-amber-950/80 border-bro-gold text-bro-gold'
            : failedCount > 0
              ? 'bg-rose-950/80 border-rose-500 text-rose-200'
              : pendingCount > 0
                ? 'bg-cyan-950/80 border-bro-cyan text-bro-cyan'
                : 'bg-bro-steel/70 border-white/10 text-emerald-400'
        }`}
      >
        {online ? <Wifi className="w-3.5 h-3.5" /> : <WifiOff className="w-3.5 h-3.5" />}
        <span>{online ? 'ONLINE' : 'BORDER DEAD-ZONE (OFFLINE)'}</span>
        {items.length > 0 && (
          <span className="px-1.5 py-0.5 rounded bg-black/50 text-white font-bold tabular-nums">
            {items.length}
          </span>
        )}
      </button>

      {open && (
        <div className="fixed inset-0 z-[115]" role="dialog" aria-modal="true" aria-label="Offline Sync Queue">
          <div className="fixed inset-0 bg-black/75 backdrop-blur-sm" onClick={() => setOpen(false)} />
          <aside className="fixed right-0 top-0 bottom-0 w-full max-w-md bg-bro-obsidian border-l border-white/10 p-6 flex flex-col justify-between z-10 overflow-y-auto">
            <div className="space-y-4">
              <div className="flex items-center justify-between border-b border-white/10 pb-3">
                <div className="flex items-center gap-2 font-mono text-xs font-bold uppercase text-white">
                  <CloudUpload className="w-4 h-4 text-bro-cyan" />
                  <span>Offline Sync Vault ({items.length})</span>
                </div>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="Close offline sync drawer"
                  className="p-1 rounded border border-white/10 text-slate-400 hover:text-white cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {items.length === 0 ? (
                <div className="p-6 rounded border border-white/10 bg-bro-steel/40 text-center font-mono text-xs text-slate-400">
                  All driver documents, DVIRs, and check-ins are synced to #BRO Cloud.
                </div>
              ) : (
                <div className="space-y-2.5">
                  {items.map((item) => (
                    <div
                      key={item.id}
                      className={`p-3 rounded border font-mono text-xs space-y-1.5 ${
                        item.status === 'failed_permanent'
                          ? 'bg-rose-950/40 border-rose-500/40'
                          : 'bg-bro-steel/60 border-white/10'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-white font-bold uppercase">{item.kind.replace(/_/g, ' ')}</span>
                        <span className="text-[10px] text-slate-400">
                          {new Date(item.createdAt).toLocaleTimeString()}
                        </span>
                      </div>
                      <div className="text-[10px] text-slate-400 truncate">
                        {item.fileName ? `Attachment: ${item.fileName}` : item.endpoint}
                      </div>
                      {item.lastError && (
                        <div className="flex items-center gap-1 text-[10px] text-rose-300">
                          <AlertTriangle className="w-3 h-3 shrink-0" />
                          <span>{item.lastError}</span>
                        </div>
                      )}
                      <div className="flex items-center justify-between pt-1">
                        <span className="text-[10px] uppercase text-bro-gold">
                          {item.status} (tries: {item.retryCount})
                        </span>
                        <button
                          type="button"
                          onClick={async () => {
                            if (item.id !== undefined) {
                              await removeQueuedSubmission(item.id);
                              await refresh();
                            }
                          }}
                          className="inline-flex items-center gap-1 text-[10px] text-slate-400 hover:text-rose-300 cursor-pointer"
                        >
                          <Trash2 className="w-3 h-3" /> Discard
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <button
              type="button"
              disabled={!online || syncing || pendingCount === 0}
              onClick={handleSyncNow}
              className="mt-4 w-full flex items-center justify-center gap-2 py-2.5 rounded bg-bro-cyan text-black font-mono text-xs font-bold uppercase disabled:opacity-40 cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
              <span>{syncing ? 'Uploading Queue...' : `Sync Pending (${pendingCount})`}</span>
            </button>
          </aside>
        </div>
      )}
    </>
  );
}
