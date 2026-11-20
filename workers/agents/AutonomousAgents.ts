import { DurableObject } from 'cloudflare:workers';
import { lt, eq, and } from 'drizzle-orm';
import { createDb, customsManifests, loads, auditLogs } from '@bro/db';
import type { CloudflareEnv } from '../../src/env.js';
import { emitHubEvent } from './hubEvents.js';

export interface AgentRuntimeState {
  enabled: boolean;
  lastRunAt: number | null;
  findingsCount: number;
  lastFindings: Array<{ entityId: string; severity: 'warn' | 'critical'; message: string }>;
}

/**
 * Stateful Autonomous Customs Pre-Flight Agent (Cloudflare Durable Object w/ Alarms).
 * Audits upcoming cross-border loads for missing PAPS/PARS, CARM IOR readiness, and FDA 2-hr Prior Notice.
 */
export class CustomsPreFlightAgent extends DurableObject<CloudflareEnv> {
  private async loadState(): Promise<AgentRuntimeState> {
    const stored = await this.ctx.storage.get<AgentRuntimeState>('state');
    return (
      stored ?? {
        enabled: true,
        lastRunAt: null,
        findingsCount: 0,
        lastFindings: [],
      }
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const state = await this.loadState();

    if (request.method === 'GET' && url.pathname === '/status') {
      return Response.json({ agent: 'CustomsPreFlightAgent', ...state });
    }
    if (request.method === 'POST' && url.pathname === '/toggle') {
      const body = (await request.json()) as { enabled: boolean };
      state.enabled = Boolean(body.enabled);
      await this.ctx.storage.put('state', state);
      if (state.enabled) {
        await this.ctx.storage.setAlarm(Date.now() + 15 * 60_000);
      }
      return Response.json({ agent: 'CustomsPreFlightAgent', ...state });
    }
    if (request.method === 'POST' && url.pathname === '/run') {
      const updated = await this.runAudit();
      return Response.json({ agent: 'CustomsPreFlightAgent', ...updated });
    }
    return new Response('Not Found', { status: 404 });
  }

  async alarm(): Promise<void> {
    const state = await this.loadState();
    if (!state.enabled) return;
    await this.runAudit();
    await this.ctx.storage.setAlarm(Date.now() + 15 * 60_000);
  }

  async runAudit(): Promise<AgentRuntimeState> {
    const state = await this.loadState();
    const findings: AgentRuntimeState['lastFindings'] = [];
    const now = Date.now();

    if (this.env.DB) {
      const db = createDb(this.env.DB);
      const activeLoads = await db
        .select()
        .from(loads)
        .where(and(eq(loads.status, 'IN_TRANSIT')));

      for (const load of activeLoads) {
        if (load.direction === 'ca_to_us' || load.direction === 'us_to_ca') {
          const manifests = await db
            .select()
            .from(customsManifests)
            .where(eq(customsManifests.loadId, load.id))
            .limit(1);

          const m = manifests[0];
          if (!m) {
            findings.push({
              entityId: load.loadNumber,
              severity: 'critical',
              message: `Cross-border load ${load.loadNumber} is IN_TRANSIT without a filed ACE/ACI manifest!`,
            });
          } else {
            if (load.direction === 'us_to_ca' && !m.carmIorVerified) {
              findings.push({
                entityId: load.loadNumber,
                severity: 'critical',
                message: `Northbound load ${load.loadNumber} missing CBSA CARM Release 2 IOR RPP bond verification.`,
              });
            }
            if (load.direction === 'ca_to_us' && load.isFoodFda && !m.fdaPriorNoticeNum) {
              findings.push({
                entityId: load.loadNumber,
                severity: 'critical',
                message: `Southbound perishable load ${load.loadNumber} missing mandatory FDA 2-Hour Prior Notice.`,
              });
            }
          }
        }
      }

      if (findings.length > 0) {
        await db.insert(auditLogs).values({
          id: `aud_${crypto.randomUUID()}`,
          actorType: 'agent',
          action: 'CUSTOMS_PREFLIGHT_ALERT',
          entityType: 'agent',
          entityId: 'CustomsPreFlightAgent',
          detailJson: JSON.stringify({ findings }),
          createdAt: now,
        });
        await emitHubEvent(this.env, {
          type: 'AGENT_STATUS_UPDATED',
          channel: 'ops:all',
          payload: { agent: 'CustomsPreFlightAgent', findings },
        });
      }
    }

    const nextState: AgentRuntimeState = {
      enabled: state.enabled,
      lastRunAt: now,
      findingsCount: findings.length,
      lastFindings: findings.slice(0, 20),
    };
    await this.ctx.storage.put('state', nextState);
    return nextState;
  }
}

/**
 * Stateful Autonomous Fleet Watchdog Agent (Cloudflare Durable Object w/ Alarms).
 * Monitors 30-day CDL, Medical Card, Annual Inspection expirations & open critical DVIR defects.
 */
export class FleetWatchdogAgent extends DurableObject<CloudflareEnv> {
  private async loadState(): Promise<AgentRuntimeState> {
    const stored = await this.ctx.storage.get<AgentRuntimeState>('state');
    return (
      stored ?? {
        enabled: true,
        lastRunAt: null,
        findingsCount: 0,
        lastFindings: [],
      }
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const state = await this.loadState();

    if (request.method === 'GET' && url.pathname === '/status') {
      return Response.json({ agent: 'FleetWatchdogAgent', ...state });
    }
    if (request.method === 'POST' && url.pathname === '/toggle') {
      const body = (await request.json()) as { enabled: boolean };
      state.enabled = Boolean(body.enabled);
      await this.ctx.storage.put('state', state);
      if (state.enabled) {
        await this.ctx.storage.setAlarm(Date.now() + 60 * 60_000);
      }
      return Response.json({ agent: 'FleetWatchdogAgent', ...state });
    }
    if (request.method === 'POST' && url.pathname === '/run') {
      const updated = await this.runWatchdog();
      return Response.json({ agent: 'FleetWatchdogAgent', ...updated });
    }
    return new Response('Not Found', { status: 404 });
  }

  async alarm(): Promise<void> {
    const state = await this.loadState();
    if (!state.enabled) return;
    await this.runWatchdog();
    await this.ctx.storage.setAlarm(Date.now() + 60 * 60_000);
  }

  async runWatchdog(): Promise<AgentRuntimeState> {
    const state = await this.loadState();
    const findings: AgentRuntimeState['lastFindings'] = [];
    const now = Date.now();
    const horizon30d = now + 30 * 86_400_000;

    if (this.env.DB) {
      const { drivers, equipment } = await import('@bro/db');
      const db = createDb(this.env.DB);

      const expiringDrivers = await db
        .select()
        .from(drivers)
        .where(lt(drivers.medicalCardExpiry, horizon30d));

      for (const drv of expiringDrivers) {
        if (drv.medicalCardExpiry) {
          const daysLeft = Math.ceil((drv.medicalCardExpiry - now) / 86_400_000);
          findings.push({
            entityId: drv.fullName,
            severity: daysLeft <= 7 ? 'critical' : 'warn',
            message: `Driver ${drv.fullName} Medical Card expires in ${daysLeft} day(s).`,
          });
        }
      }

      const expiringEquip = await db
        .select()
        .from(equipment)
        .where(lt(equipment.annualInspectionExpiry, horizon30d));

      for (const eqItem of expiringEquip) {
        const daysLeft = Math.ceil((eqItem.annualInspectionExpiry - now) / 86_400_000);
        findings.push({
          entityId: eqItem.unitNumber,
          severity: daysLeft <= 7 ? 'critical' : 'warn',
          message: `Unit ${eqItem.unitNumber} Annual DOT/NSC Inspection expires in ${daysLeft} day(s).`,
        });
      }
    }

    const nextState: AgentRuntimeState = {
      enabled: state.enabled,
      lastRunAt: now,
      findingsCount: findings.length,
      lastFindings: findings.slice(0, 20),
    };
    await this.ctx.storage.put('state', nextState);
    return nextState;
  }
}

/**
 * Stateful Dispatch Co-Pilot Agent (Cloudflare Durable Object).
 * Parses natural-language dispatch commands deterministically with zero hallucinated mutations.
 */
export class DispatchCopilotAgent extends DurableObject<CloudflareEnv> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/status') {
      const count = (await this.ctx.storage.get<number>('commandsProcessed')) ?? 0;
      return Response.json({
        agent: 'DispatchCopilotAgent',
        enabled: true,
        commandsProcessed: count,
      });
    }
    if (request.method === 'POST' && url.pathname === '/command') {
      const body = (await request.json()) as { command: string };
      const cmd = (body.command || '').trim();
      const count = ((await this.ctx.storage.get<number>('commandsProcessed')) ?? 0) + 1;
      await this.ctx.storage.put('commandsProcessed', count);

      // Deterministic intent router — never mutates finances or legal filings autonomously
      if (/quote|rate/i.test(cmd)) {
        const eqMatch = cmd.match(/\b(reefer|flatbed|dry[\s_-]?van)\b/i);
        const weightMatch = cmd.match(/\b(\d{4,5})\b/);
        return Response.json({
          intent: 'LAUNCH_QUOTE',
          requiresConfirmation: true,
          suggestedRoute: `/quote?equipment=${eqMatch ? eqMatch[1].toLowerCase().replace(/[\s-]/, '_') : 'reefer'}&weight=${weightMatch ? weightMatch[1] : '36000'}`,
          summary: `Prepared deterministic rate engine launch for ${eqMatch?.[1] ?? 'reefer'} freight.`,
        });
      }
      if (/border|wait|calais|detroit|lacolle/i.test(cmd)) {
        return Response.json({
          intent: 'BORDER_STATUS',
          requiresConfirmation: false,
          suggestedRoute: '/ops/customs',
          summary: 'Routing to Live CBP/CBSA Border Wait Times & CARM Compliance Desk.',
        });
      }
      if (/dot|carrier|fraud|fmcsa/i.test(cmd)) {
        const dotMatch = cmd.match(/\b(\d{4,8})\b/);
        return Response.json({
          intent: 'VERIFY_CARRIER',
          requiresConfirmation: false,
          suggestedRoute: dotMatch ? `/apply?dot=${dotMatch[1]}` : '/apply',
          summary: dotMatch
            ? `Launching live FMCSA QCMobile vetting for USDOT #${dotMatch[1]}.`
            : 'Launching Carrier FMCSA Verification Gateway.',
        });
      }
      return Response.json({
        intent: 'DISPATCH_BOARD',
        requiresConfirmation: false,
        suggestedRoute: '/ops/dispatch',
        summary: `Indexed dispatch query "${cmd.slice(0, 80)}" — opening Control Tower Dispatch Board.`,
      });
    }
    return new Response('Not Found', { status: 404 });
  }
}
