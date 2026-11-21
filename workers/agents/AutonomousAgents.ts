import { DurableObject } from 'cloudflare:workers';
import { eq, inArray } from 'drizzle-orm';
import {
  createDb,
  customsManifests,
  loads,
  drivers,
  equipment,
  dvirInspections,
  auditLogs,
} from '@bro/db';
import type { CloudflareEnv } from '../../src/env.js';
import { emitHubEvent } from './hubEvents.js';

export interface AgentRuntimeState {
  enabled: boolean;
  lastRunAt: number | null;
  findingsCount: number;
  lastFindings: Array<{ entityId: string; severity: 'warn' | 'critical'; message: string }>;
  alarmArmed?: boolean;
}

/**
 * Stateful Autonomous Customs Pre-Flight Agent (Cloudflare Durable Object w/ Alarms).
 * Audits all active cross-border loads (BOOKED -> AT_BORDER) for missing PAPS/PARS,
 * CARM Release 2 IOR RPP bond verification, and FDA 2-hr Prior Notice.
 */
export class CustomsPreFlightAgent extends DurableObject<CloudflareEnv> {
  private async loadState(): Promise<AgentRuntimeState> {
    const stored = await this.ctx.storage.get<AgentRuntimeState>('state');
    const state: AgentRuntimeState = stored ?? {
      enabled: true,
      lastRunAt: null,
      findingsCount: 0,
      lastFindings: [],
      alarmArmed: false,
    };
    if (state.enabled && !state.alarmArmed) {
      try {
        await this.ctx.storage.setAlarm(Date.now() + 15 * 60_000);
        state.alarmArmed = true;
        await this.ctx.storage.put('state', state);
      } catch {
        // Ignore if alarm storage not available in unit test mock
      }
    }
    return state;
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
      state.alarmArmed = state.enabled;
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
        .where(
          inArray(loads.status, ['BOOKED', 'DISPATCHED', 'AT_PICKUP', 'IN_TRANSIT', 'AT_BORDER']),
        );

      for (const load of activeLoads) {
        if (load.direction === 'ca_to_us' || load.direction === 'us_to_ca') {
          const manifests = await db
            .select()
            .from(customsManifests)
            .where(eq(customsManifests.loadId, load.id))
            .limit(1);

          const m = manifests[0];
          const isRolling = load.status === 'IN_TRANSIT' || load.status === 'AT_BORDER';
          if (!m) {
            findings.push({
              entityId: load.loadNumber,
              severity: isRolling ? 'critical' : 'warn',
              message: `Cross-border load ${load.loadNumber} (${load.status}) has no filed ACE/ACI manifest!`,
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
            if (m.status === 'held') {
              findings.push({
                entityId: load.loadNumber,
                severity: 'critical',
                message: `Customs manifest ${m.controlNumber} for load ${load.loadNumber} is currently HELD at Port ${m.portCode}.`,
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
      alarmArmed: state.enabled,
    };
    await this.ctx.storage.put('state', nextState);
    return nextState;
  }
}

/**
 * Stateful Autonomous Fleet Watchdog Agent (Cloudflare Durable Object w/ Alarms).
 * Monitors 30-day CDL, Medical Card, Annual Inspection expirations, open DVIR defects & OOS units.
 */
export class FleetWatchdogAgent extends DurableObject<CloudflareEnv> {
  private async loadState(): Promise<AgentRuntimeState> {
    const stored = await this.ctx.storage.get<AgentRuntimeState>('state');
    const state: AgentRuntimeState = stored ?? {
      enabled: true,
      lastRunAt: null,
      findingsCount: 0,
      lastFindings: [],
      alarmArmed: false,
    };
    if (state.enabled && !state.alarmArmed) {
      try {
        await this.ctx.storage.setAlarm(Date.now() + 60 * 60_000);
        state.alarmArmed = true;
        await this.ctx.storage.put('state', state);
      } catch {
        // Ignore in test harness
      }
    }
    return state;
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
      state.alarmArmed = state.enabled;
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
      const db = createDb(this.env.DB);

      const [allDrivers, allEquip, dvirs] = await Promise.all([
        db.select().from(drivers).limit(60),
        db.select().from(equipment).limit(60),
        db.select().from(dvirInspections).limit(40),
      ]);

      for (const drv of allDrivers) {
        if (drv.medicalCardExpiry && drv.medicalCardExpiry < horizon30d) {
          const daysLeft = Math.ceil((drv.medicalCardExpiry - now) / 86_400_000);
          findings.push({
            entityId: drv.fullName,
            severity: daysLeft <= 7 ? 'critical' : 'warn',
            message: `Driver ${drv.fullName} Medical Card expires in ${daysLeft} day(s).`,
          });
        }
        if (drv.licenseExpiry && drv.licenseExpiry < horizon30d) {
          const daysLeft = Math.ceil((drv.licenseExpiry - now) / 86_400_000);
          findings.push({
            entityId: drv.fullName,
            severity: daysLeft <= 7 ? 'critical' : 'warn',
            message: `Driver ${drv.fullName} Commercial Driver License (${drv.licenseClass ?? 'Class 1'}) expires in ${daysLeft} day(s).`,
          });
        }
      }

      for (const eqItem of allEquip) {
        if (eqItem.annualInspectionExpiry < horizon30d) {
          const daysLeft = Math.ceil((eqItem.annualInspectionExpiry - now) / 86_400_000);
          findings.push({
            entityId: eqItem.unitNumber,
            severity: daysLeft <= 7 ? 'critical' : 'warn',
            message: `Unit ${eqItem.unitNumber} Annual DOT/NSC Inspection expires in ${daysLeft} day(s).`,
          });
        }
        if (eqItem.status === 'out_of_service') {
          findings.push({
            entityId: eqItem.unitNumber,
            severity: 'critical',
            message: `Unit ${eqItem.unitNumber} is locked OUT_OF_SERVICE pending shop safety sign-off.`,
          });
        }
      }

      for (const dvir of dvirs) {
        if ((!dvir.safeToOperate || dvir.defectsFound) && !dvir.mechanicClearedAt) {
          findings.push({
            entityId: dvir.id,
            severity: dvir.safeToOperate ? 'warn' : 'critical',
            message: `Un-cleared DVIR defect logged by ${dvir.driverSignatureName} on tractor ${dvir.tractorId}.`,
          });
        }
      }

      if (findings.length > 0) {
        await db.insert(auditLogs).values({
          id: `aud_${crypto.randomUUID()}`,
          actorType: 'agent',
          action: 'FLEET_WATCHDOG_ALERT',
          entityType: 'agent',
          entityId: 'FleetWatchdogAgent',
          detailJson: JSON.stringify({ findings: findings.slice(0, 20) }),
          createdAt: now,
        });
        await emitHubEvent(this.env, {
          type: 'AGENT_STATUS_UPDATED',
          channel: 'ops:all',
          payload: { agent: 'FleetWatchdogAgent', findings: findings.slice(0, 20) },
        });
      }
    }

    const nextState: AgentRuntimeState = {
      enabled: state.enabled,
      lastRunAt: now,
      findingsCount: findings.length,
      lastFindings: findings.slice(0, 20),
      alarmArmed: state.enabled,
    };
    await this.ctx.storage.put('state', nextState);
    return nextState;
  }
}

/**
 * Stateful Dispatch Co-Pilot Agent (Cloudflare Durable Object).
 * Parses natural-language dispatch commands deterministically with live D1 load & equipment telemetry.
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
      if (/border|wait|calais|detroit|lacolle|customs|carm|paps|pars/i.test(cmd)) {
        return Response.json({
          intent: 'BORDER_STATUS',
          requiresConfirmation: false,
          suggestedRoute: '/ops/customs',
          summary: 'Routing to Live CBP/CBSA Border Wait Times & CARM Compliance Desk.',
        });
      }
      if (/dot|carrier|fraud|fmcsa|recruit|applicant/i.test(cmd)) {
        const dotMatch = cmd.match(/\b(\d{4,8})\b/);
        return Response.json({
          intent: 'VERIFY_CARRIER',
          requiresConfirmation: false,
          suggestedRoute: dotMatch ? `/apply?dot=${dotMatch[1]}` : '/ops/onboarding',
          summary: dotMatch
            ? `Launching live FMCSA QCMobile vetting for USDOT #${dotMatch[1]}.`
            : 'Opening Driver & Carrier Recruiting Vetting Desk.',
        });
      }
      if (/plan|backhaul|deadhead|yield/i.test(cmd)) {
        return Response.json({
          intent: 'LOAD_PLANNER',
          requiresConfirmation: false,
          suggestedRoute: '/ops/planner',
          summary: 'Routing to Corridor Load Planner & Backhaul Yield Desk.',
        });
      }
      if (/settle|payroll|driver pay/i.test(cmd)) {
        return Response.json({
          intent: 'SETTLEMENTS',
          requiresConfirmation: false,
          suggestedRoute: '/ops/settlements',
          summary: 'Routing to Driver Payroll & Settlement Audit Desk.',
        });
      }
      if (/shop|maintenance|work order|dvir|repair/i.test(cmd)) {
        return Response.json({
          intent: 'SHOP_MAINTENANCE',
          requiresConfirmation: false,
          suggestedRoute: '/ops/maintenance',
          summary: 'Routing to Shop Maintenance & DVIR Work Order Desk.',
        });
      }

      let liveContext = '';
      if (this.env.DB) {
        try {
          const db = createDb(this.env.DB);
          const [activeLoads, equipRows] = await Promise.all([
            db.select().from(loads).limit(30),
            db.select().from(equipment).limit(30),
          ]);
          const moving = activeLoads.filter((l) => l.status !== 'PAID').length;
          const oos = equipRows.filter((e) => e.status === 'out_of_service').length;
          liveContext = ` (${moving} active loads, ${oos} OOS units)`;
        } catch {
          // ignore
        }
      }

      return Response.json({
        intent: 'DISPATCH_BOARD',
        requiresConfirmation: false,
        suggestedRoute: '/ops/dispatch',
        summary: `Indexed dispatch query "${cmd.slice(0, 80)}"${liveContext} — opening Control Tower Dispatch Board.`,
      });
    }
    return new Response('Not Found', { status: 404 });
  }
}
