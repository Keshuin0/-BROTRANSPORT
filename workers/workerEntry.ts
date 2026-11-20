import type { SSRManifest } from 'astro';
import { App } from 'astro/app';
import { handle } from '@astrojs/cloudflare/handler';
import type { CloudflareEnv } from '../src/env.js';
import { OpsHubDO } from './agents/OpsHubDO.js';
import {
  CustomsPreFlightAgent,
  DispatchCopilotAgent,
  FleetWatchdogAgent,
} from './agents/AutonomousAgents.js';
import { DocumentProcessingWorkflow } from './workflows/DocumentProcessingWorkflow.js';
import { BillingSettlementWorkflow } from './workflows/BillingSettlementWorkflow.js';
import { handleBorderSyncScheduled } from './cron/borderSync.js';

/**
 * Unified Cloudflare Workers Entrypoint for #BRO Transport Dual-Portal OS.
 * Bundles Astro SSR + Hono Edge API + 4 Stateful Durable Objects + 2 Cloudflare Workflows + 10-min Cron Trigger.
 */
export function createExports(manifest: SSRManifest) {
  const app = new App(manifest);

  return {
    default: {
      async fetch(request: Request, env: CloudflareEnv, ctx: ExecutionContext) {
        return await handle(manifest, app, request as never, env as never, ctx as never);
      },
      async scheduled(
        controller: ScheduledController,
        env: CloudflareEnv,
        ctx: ExecutionContext,
      ) {
        await handleBorderSyncScheduled(controller, env, ctx);
      },
    },
    OpsHubDO,
    CustomsPreFlightAgent,
    DispatchCopilotAgent,
    FleetWatchdogAgent,
    DocumentProcessingWorkflow,
    BillingSettlementWorkflow,
  };
}
