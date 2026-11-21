import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Wifi, WifiOff, RefreshCw, Trash2, AlertTriangle, CloudUpload, X } from 'lucide-react';
import {
  listOfflineQueue,
  flushOfflineQueue,
  removeQueuedSubmission,
  type QueuedSubmission,
} from '../../lib/offlineDb';
import { useModalFocusTrap } from '../../lib/useModalFocusTrap';

export default function OfflineSyncDrawer() {
  const [online, setOnline] = useState(true);
  const [edgeVerifiedFallback, setEdgeVerifiedFallback] = useState(false);
  const [items, setItems] = useState<QueuedSubmission[]>([]);
  const [open, setOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const probeControllerRef = useRef<AbortController | null>(null);

  const { mounted, visible, containerRef } = useModalFocusTrap<HTMLElement, HTMLButtonElement>({
    open,
    onClose: () => setOpen(false),
    initialFocusRef: closeBtnRef,
  });

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

  const probeConnectivity = useCallback(
    async (syncOnSuccess: boolean) => {
      probeControllerRef.current?.abort();
      const controller = new AbortController();
      probeControllerRef.current = controller;
      const timeoutId = window.setTimeout(() => controller.abort(), 4500);

      try {
        const res = await fetch('/api/health', {
          cache: 'no-store',
          signal: controller.signal,
        });

        if (res.ok) {
          const browserReportsOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
          setOnline(true);
          setEdgeVerifiedFallback(browserReportsOffline);
          if (syncOnSuccess) {
            void handleSyncNow();
          }
          return;
        }

        setOnline(false);
        setEdgeVerifiedFallback(false);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError' && controller.signal.aborted) {
          // Only mark offline on timeout abort if component didn't unmount/supersede
          if (probeControllerRef.current !== controller) return;
        }
        setOnline(false);
        setEdgeVerifiedFallback(false);
      } finally {
        window.clearTimeout(timeoutId);
      }
    },
    [handleSyncNow],
  );

  useEffect(() => {
    const initialBrowserOnline = typeof navigator !== 'undefined' ? navigator.onLine : true;
    setOnline(initialBrowserOnline);
    setEdgeVerifiedFallback(false);

    void refresh();
    void probeConnectivity(false);

    const onOnline = () => {
      void probeConnectivity(true);
    };
    const onOffline = () => {
      void probeConnectivity(false);
    };
    const onQueueChange = () => void refresh();

    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    window.addEventListener('bro:offline-queue-updated', onQueueChange);
    return () => {
      probeControllerRef.current?.abort();
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('bro:offline-queue-updated', onQueueChange);
    };
  }, [refresh, probeConnectivity]);

  const pendingCount = items.filter((i) => i.status !== 'failed_permanent').length;
  const failedCount = items.filter((i) => i.status === 'failed_permanent').length;

  const statusLabel = !online
    ? 'BORDER DEAD-ZONE (OFFLINE)'
    : edgeVerifiedFallback
      ? 'ONLINE (EDGE VERIFIED)'
      : 'ONLINE';

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`min-h-[44px] inline-flex items-center gap-2 px-4 py-2 rounded-full border text-xs font-semibold transition-colors cursor-pointer ${
          !online
            ? 'bg-amber-950/80 border-bro-gold text-amber-200'
            : failedCount > 0
              ? 'bg-rose-950/80 border-rose-500 text-rose-200'
              : pendingCount > 0
                ? 'bg-cyan-950/80 border-bro-cyan text-bro-cyan'
                : 'bg-[#060912] border-emerald-500/40 text-emerald-300 hover:border-emerald-400'
        }`}
      >
        {online ? (
          <Wifi className="w-4 h-4 shrink-0" aria-hidden="true" />
        ) : (
          <WifiOff className="w-4 h-4 shrink-0" aria-hidden="true" />
        )}
        <span>{statusLabel}</span>
        {items.length > 0 && (
          <span className="px-2 py-0.5 rounded-full bg-black/50 text-white font-bold tabular-nums">
            {items.length}
          </span>
        )}
      </button>

      {mounted && (
        <div
          className="fixed inset-0 z-[115]"
          role="dialog"
          aria-modal="true"
          aria-labelledby="offline-vault-title"
        >
          <div
            className="bro-modal-backdrop fixed inset-0 bg-black/75 backdrop-blur-sm"
            data-visible={visible ? 'true' : 'false'}
            onClick={() => setOpen(false)}
          />
          <aside
            ref={containerRef}
            data-visible={visible ? 'true' : 'false'}
            className="bro-drawer-panel fixed right-0 top-0 bottom-0 w-full max-w-md liquid-glass border-l border-white/15 p-6 flex flex-col justify-between z-10 overflow-y-auto"
          >
            <div className="space-y-4">
              <div className="flex items-center justify-between border-b border-white/10 pb-3.5">
                <div className="flex items-center gap-2.5">
                  <CloudUpload className="w-5 h-5 text-bro-cyan shrink-0" aria-hidden="true" />
                  <h2 id="offline-vault-title" className="font-display text-base font-bold text-white">
                    Offline Sync Vault ({items.length})
                  </h2>
                </div>
                <button
                  ref={closeBtnRef}
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="Close offline sync drawer"
                  className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded-full border border-white/15 bg-[#060912] text-slate-300 hover:text-white hover:border-white/30 cursor-pointer transition-colors"
                >
                  <X className="w-4 h-4" aria-hidden="true" />
                </button>
              </div>

              <div className="px-3.5 py-2.5 rounded-xl bg-[#060912] border border-white/10 flex items-center justify-between text-xs">
                <span className="text-slate-300">Edge Link Status</span>
                <span className={online ? 'text-emerald-300 font-semibold' : 'text-bro-gold font-semibold'}>
                  {statusLabel}
                </span>
              </div>

              {items.length === 0 ? (
                <div className="p-6 rounded-2xl surface-ceramic text-center text-xs text-slate-300 leading-relaxed">
                  All driver documents, DVIRs, and check-ins are synced to #BRO Cloud.
                </div>
              ) : (
                <div className="space-y-3">
                  {items.map((item) => (
                    <div
                      key={item.id}
                      className={`p-4 rounded-2xl border text-xs space-y-2 ${
                        item.status === 'failed_permanent'
                          ? 'bg-rose-950/50 border-rose-500/50'
                          : 'surface-ceramic'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-white font-semibold uppercase">
                          {item.kind.replace(/_/g, ' ')}
                        </span>
                        <span className="text-xs text-slate-400 tabular-nums">
                          {new Date(item.createdAt).toLocaleTimeString()}
                        </span>
                      </div>
                      <div className="text-xs text-slate-300 truncate font-mono">
                        {item.fileName ? `Attachment: ${item.fileName}` : item.endpoint}
                      </div>
                      {item.lastError && (
                        <div className="flex items-start gap-1.5 text-xs text-rose-200">
                          <AlertTriangle className="w-4 h-4 shrink-0 text-rose-400 mt-0.5" aria-hidden="true" />
                          <span>{item.lastError}</span>
                        </div>
                      )}
                      <div className="flex items-center justify-between gap-2 pt-1">
                        <span className="px-2.5 py-1 rounded-full bg-[#060912] border border-white/10 text-xs font-medium text-bro-gold uppercase">
                          {item.status.replace(/_/g, ' ')} (tries: {item.retryCount})
                        </span>
                        <button
                          type="button"
                          onClick={async () => {
                            if (item.id !== undefined) {
                              await removeQueuedSubmission(item.id);
                              await refresh();
                            }
                          }}
                          className="min-h-[44px] min-w-[44px] inline-flex items-center gap-1.5 px-3 py-2 rounded-full border border-white/15 bg-[#060912] text-xs font-medium text-slate-300 hover:text-rose-200 hover:border-rose-500/50 cursor-pointer transition-colors"
                        >
                          <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                          <span>Discard</span>
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
              className="mt-5 w-full min-h-[48px] flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-bro-cyan hover:bg-cyan-300 text-black text-sm font-semibold disabled:opacity-40 cursor-pointer transition-colors"
            >
              <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} aria-hidden="true" />
              <span>{syncing ? 'Uploading Queue...' : `Sync Pending (${pendingCount})`}</span>
            </button>
          </aside>
        </div>
      )}
    </>
  );
}
