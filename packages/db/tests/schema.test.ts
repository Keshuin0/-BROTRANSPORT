import { describe, it, expect } from 'vitest';
import { getTableName } from 'drizzle-orm';
import * as schema from '../src/schema.js';

describe('@bro/db — 18-Table Cloudflare D1 Relational Schema', () => {
  it('defines all expected normalized trucking, customs, eBOL, billing, and auth tables', () => {
    const tables = [
      schema.organizations,
      schema.users,
      schema.sessions,
      schema.accounts,
      schema.verifications,
      schema.passkeys,
      schema.drivers,
      schema.equipment,
      schema.quotes,
      schema.loads,
      schema.loadStops,
      schema.documents,
      schema.customsManifests,
      schema.ebolBlocks,
      schema.invoices,
      schema.driverSettlements,
      schema.iftaLogs,
      schema.dvirInspections,
      schema.telematicsEvents,
      schema.ediMessages,
      schema.escalations,
      schema.auditLogs,
    ];
    const names = tables.map((t) => getTableName(t));
    expect(names).toContain('organizations');
    expect(names).toContain('loads');
    expect(names).toContain('documents');
    expect(names).toContain('customs_manifests');
    expect(names).toContain('ebol_blocks');
    expect(names).toContain('invoices');
    expect(names).toContain('driver_settlements');
    expect(names).toContain('ifta_logs');
    expect(names).toContain('dvir_inspections');
    expect(names).toContain('edi_messages');
    expect(names).toContain('escalations');
    expect(new Set(names).size).toBe(tables.length);
  });
});
