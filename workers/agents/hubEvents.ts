import type { CloudflareEnv } from '../../src/env.js';

export type HubEventType =
  | 'DOC_OCR_READY'
  | 'LOAD_STATUS_CHANGED'
  | 'BORDER_WAIT_UPDATED'
  | 'RNS_CLEARED'
  | 'ESCALATION_CREATED'
  | 'INVOICE_READY'
  | 'TELEMATICS_ALERT'
  | 'EDI_TENDER_RECEIVED'
  | 'AGENT_STATUS_UPDATED';

export interface HubBroadcastEvent {
  type: HubEventType;
  channel: string; // e.g., 'ops:all', 'org:org_123', 'driver:drv_01', 'public:borders'
  timestamp: number;
  payload: Record<string, unknown>;
}

/**
 * Safely broadcasts a real-time pub/sub event to OpsHubDO when bound in Cloudflare Workers runtime.
 * Kept free of `cloudflare:workers` runtime imports so API routes remain cleanly testable in Vitest/Node.
 */
export async function emitHubEvent(
  env: Partial<CloudflareEnv> | undefined,
  event: Omit<HubBroadcastEvent, 'timestamp'>,
): Promise<void> {
  if (!env?.OPS_HUB) return;
  try {
    const id = env.OPS_HUB.idFromName('global-ops-hub');
    const stub = env.OPS_HUB.get(id);
    await stub.fetch('https://ops-hub.internal/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...event, timestamp: Date.now() }),
    });
  } catch (err) {
    console.warn('[OpsHubDO] broadcast skipped:', err);
  }
}
