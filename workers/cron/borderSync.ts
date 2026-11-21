import type { CloudflareEnv } from '../../src/env';
import { syncBorderWaitTimes, type BorderWaitFeed } from '../services/borderWaitTimes';

const OPS_HUB_SINGLETON_NAME = 'global-ops-hub';
export const BORDER_WAIT_BROADCAST_CHANNELS = ['ops:all', 'public:borders'] as const;

export interface BorderSyncCronResult {
  feed: BorderWaitFeed;
  hubNotified: boolean;
  hubError?: string;
}

/**
 * Executes the border wait times sync and pushes a live broadcast event to OpsHubDO if bound.
 */
export async function runBorderSync(
  env: Pick<Partial<CloudflareEnv>, 'CACHE' | 'OPS_HUB'>,
  cron = '*/10 * * * *',
  fetchImpl: typeof fetch = fetch,
): Promise<BorderSyncCronResult> {
  const feed = await syncBorderWaitTimes(env, fetchImpl);

  if (!env.OPS_HUB) {
    return { feed, hubNotified: false };
  }

  try {
    const id = env.OPS_HUB.idFromName(OPS_HUB_SINGLETON_NAME);
    const stub = env.OPS_HUB.get(id);
    const timestamp = Date.now();

    for (const channel of BORDER_WAIT_BROADCAST_CHANNELS) {
      const response = await stub.fetch('https://ops-hub.internal/broadcast', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          type: 'BORDER_WAIT_UPDATED',
          channel,
          timestamp,
          payload: {
            cron,
            fetchedAt: feed.fetchedAt,
            stale: feed.stale,
            sources: feed.sources,
            ports: feed.ports,
          },
          cron,
          fetchedAt: feed.fetchedAt,
          stale: feed.stale,
          sources: feed.sources,
          ports: feed.ports,
        }),
      });

      if (!response.ok) {
        return {
          feed,
          hubNotified: false,
          hubError: `OpsHubDO responded with HTTP ${response.status}`,
        };
      }
    }

    return { feed, hubNotified: true };
  } catch (err) {
    return {
      feed,
      hubNotified: false,
      hubError: err instanceof Error ? err.message : 'Failed to notify OpsHubDO',
    };
  }
}

/**
 * Cloudflare Workers Cron Trigger handler (every 10 minutes).
 */
export async function handleBorderSyncScheduled(
  controller: ScheduledController,
  env: CloudflareEnv,
  ctx: ExecutionContext,
): Promise<void> {
  ctx.waitUntil(runBorderSync(env, controller.cron));
}

export default {
  scheduled: handleBorderSyncScheduled,
};
