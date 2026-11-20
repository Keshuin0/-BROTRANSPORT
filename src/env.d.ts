/// <reference types="astro/client" />
/// <reference types="@cloudflare/workers-types" />

import type { UserRole } from '@bro/contracts';

export interface WorkflowBinding<P = unknown> {
  create(options?: { id?: string; params?: P }): Promise<{ id: string }>;
  get(id: string): Promise<{
    id: string;
    status(): Promise<{ status: string; output?: unknown; error?: string }>;
    sendEvent(options: { type: string; payload?: unknown }): Promise<void>;
  }>;
}

export interface CloudflareEnv {
  ASSETS?: Fetcher;
  DB: D1Database;
  VAULT: R2Bucket;
  CACHE: KVNamespace;
  AI?: {
    run(model: string, input: Record<string, unknown>): Promise<unknown>;
  };
  OPS_HUB?: DurableObjectNamespace;
  CUSTOMS_AGENT?: DurableObjectNamespace;
  DISPATCH_AGENT?: DurableObjectNamespace;
  WATCHDOG_AGENT?: DurableObjectNamespace;
  DOC_WORKFLOW?: WorkflowBinding;
  BILLING_WORKFLOW?: WorkflowBinding;
  ENVIRONMENT?: string;
  PUBLIC_APP_URL?: string;
  PUBLIC_TURNSTILE_SITE_KEY?: string;
  SCAC_CODE?: string;
  BETTER_AUTH_SECRET?: string;
  TURNSTILE_SECRET_KEY?: string;
  RESEND_API_KEY?: string;
  FMCSA_WEB_KEY?: string;
  RNS_WEBHOOK_SECRET?: string;
  EDI_WEBHOOK_SECRET?: string;
  TELEMATICS_WEBHOOK_SECRET?: string;
  STRIPE_SECRET_KEY?: string;
}

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  organizationId: string | null;
}

declare global {
  namespace App {
    interface Locals {
      runtime?: {
        env: CloudflareEnv;
        ctx: ExecutionContext;
      };
      user: SessionUser | null;
      sessionId: string | null;
    }
  }
}
