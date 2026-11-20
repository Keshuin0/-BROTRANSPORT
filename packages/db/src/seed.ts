import type { BroDatabase } from './client.js';
import {
  organizations,
  users,
  drivers,
  equipment,
  loads,
  loadStops,
  customsManifests,
  invoices,
  iftaLogs,
  telematicsEvents,
  auditLogs,
} from './schema.js';

/**
 * Deterministic seed dataset for local development and demo verification.
 * Uses authentic Atlantic Canada <-> North America commercial lanes (zero cliché placeholder names).
 */
export async function seedDatabase(db: BroDatabase, now = Date.now()): Promise<void> {
  const day = 86_400_000;

  await db
    .insert(organizations)
    .values([
      {
        id: 'org_bro_internal',
        name: '#BRO Transport Corp.',
        type: 'internal',
        usdot: '3849201',
        mcNumber: 'MC1482910',
        scac: 'BROP',
        craBnRm: '849201142RM0001',
        carmRppVerified: true,
        currency: 'CAD',
        paymentTermsDays: 30,
        billingEmail: 'billing@brotransport.com',
        phone: '902-555-0140',
        address: '140 Industrial Crescent, Charlottetown, PE C1A 8K2',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'org_cavendish_produce',
        name: 'Cavendish Valley Produce Co.',
        type: 'shipper',
        craBnRm: '719283410RM0001',
        carmRppVerified: true,
        currency: 'CAD',
        paymentTermsDays: 30,
        billingEmail: 'ap@cavendishvalley.example',
        phone: '902-555-0192',
        address: '100 Harvest Rd, Summerside, PE C1N 4J8',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'org_fundy_steel',
        name: 'Fundy Structural Steel Ltd.',
        type: 'shipper',
        craBnRm: '604918220RM0001',
        carmRppVerified: true,
        currency: 'USD',
        paymentTermsDays: 30,
        billingEmail: 'logistics@fundysteel.example',
        phone: '506-555-0118',
        address: '88 Caledonia Industrial Pkwy, Moncton, NB E1H 2R5',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      },
    ])
    .onConflictDoNothing();

  await db
    .insert(users)
    .values([
      {
        id: 'usr_admin_01',
        name: 'Keshav Operations Admin',
        email: 'admin@brotransport.com',
        emailVerified: true,
        role: 'super_admin',
        organizationId: 'org_bro_internal',
        phone: '902-555-0101',
        active: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'usr_disp_01',
        name: 'Claire Arsenault',
        email: 'dispatch@brotransport.com',
        emailVerified: true,
        role: 'dispatcher',
        organizationId: 'org_bro_internal',
        phone: '902-555-0102',
        active: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'usr_shipper_01',
        name: 'Owen MacLeod',
        email: 'owen@cavendishvalley.example',
        emailVerified: true,
        role: 'shipper_admin',
        organizationId: 'org_cavendish_produce',
        phone: '902-555-0192',
        active: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'usr_driver_01',
        name: 'Liam Gallant',
        email: 'liam.gallant@brotransport.com',
        emailVerified: true,
        role: 'carrier_driver',
        organizationId: 'org_bro_internal',
        phone: '902-555-0174',
        active: true,
        createdAt: now,
        updatedAt: now,
      },
    ])
    .onConflictDoNothing();

  await db
    .insert(drivers)
    .values([
      {
        id: 'drv_01',
        userId: 'usr_driver_01',
        organizationId: 'org_bro_internal',
        fullName: 'Liam Gallant',
        phone: '902-555-0174',
        email: 'liam.gallant@brotransport.com',
        equipmentDivision: 'reefer',
        preferredLanes: 'PEI -> Boston, Halifax -> Montreal',
        licenseNumber: 'PE-9482011',
        licenseClass: 'Class 1',
        licenseExpiry: now + 310 * day,
        medicalCardExpiry: now + 22 * day, // Triggers 30-day Watchdog alert!
        fastCardNumber: '980012345',
        payModel: 'cpm',
        payRateValue: 72,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'drv_02',
        organizationId: 'org_bro_internal',
        fullName: 'Nadia Tremblay',
        phone: '506-555-0188',
        email: 'nadia.tremblay@brotransport.com',
        equipmentDivision: 'flatbed',
        preferredLanes: 'Moncton -> Toronto, Montreal -> Detroit',
        licenseNumber: 'NB-7721904',
        licenseClass: 'Class 1 / AZ',
        licenseExpiry: now + 420 * day,
        medicalCardExpiry: now + 180 * day,
        fastCardNumber: '980077421',
        payModel: 'percent_gross',
        payRateValue: 8200,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      },
    ])
    .onConflictDoNothing();

  await db
    .insert(equipment)
    .values([
      {
        id: 'eq_trc_101',
        unitNumber: 'TRC-101',
        type: 'tractor',
        vin: '1HGCM82633A004352',
        plate: 'PE9948',
        jurisdiction: 'PE',
        gvwrKg: 36287,
        operatingHours: 2450,
        annualInspectionExpiry: now + 190 * day,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'eq_rf_4221',
        unitNumber: 'RF-4221',
        type: 'reefer',
        vin: '1HGCM82633A004352',
        plate: 'PE-RF4221',
        jurisdiction: 'PE',
        gvwrKg: 36287,
        operatingHours: 1840,
        annualInspectionExpiry: now + 140 * day,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'eq_fb_5022',
        unitNumber: 'FB-5022',
        type: 'flatbed',
        vin: '1HGCM82633A004352',
        plate: 'NB-FB5022',
        jurisdiction: 'NB',
        gvwrKg: 36287,
        operatingHours: 3120,
        annualInspectionExpiry: now + 18 * day, // Triggers 30-day Watchdog alert!
        status: 'active',
        createdAt: now,
        updatedAt: now,
      },
    ])
    .onConflictDoNothing();

  await db
    .insert(loads)
    .values([
      {
        id: 'load_9948',
        loadNumber: 'BROP-2026-9948',
        shipperOrgId: 'org_cavendish_produce',
        assignedDriverId: 'drv_01',
        tractorId: 'eq_trc_101',
        trailerId: 'eq_rf_4221',
        equipmentType: 'reefer',
        direction: 'ca_to_us',
        status: 'AT_BORDER',
        commodity: 'Chilled PEI Potatoes & Atlantic Seafood',
        weightLbs: 38400,
        loadedMiles: 652,
        tempSetpointC: 4.0,
        isFoodFda: true,
        rateCustomerCents: 385000,
        rateCarrierCents: 215000,
        currency: 'CAD',
        detentionMinutes: 0,
        createdAt: now - day,
        updatedAt: now,
      },
      {
        id: 'load_9949',
        loadNumber: 'BROP-2026-9949',
        shipperOrgId: 'org_fundy_steel',
        assignedDriverId: 'drv_02',
        tractorId: 'eq_trc_101',
        trailerId: 'eq_fb_5022',
        equipmentType: 'flatbed',
        direction: 'us_to_ca',
        status: 'DELIVERED',
        commodity: 'Galvanized Structural Steel I-Beams',
        weightLbs: 42100,
        loadedMiles: 890,
        isFoodFda: false,
        rateCustomerCents: 462000,
        rateCarrierCents: 310000,
        currency: 'USD',
        detentionMinutes: 45,
        createdAt: now - 3 * day,
        updatedAt: now - 3600_000,
      },
    ])
    .onConflictDoNothing();

  await db
    .insert(loadStops)
    .values([
      {
        id: 'stop_9948_1',
        loadId: 'load_9948',
        seq: 1,
        stopType: 'pickup',
        facilityName: 'Cavendish Valley Cold Storage',
        address: '100 Harvest Rd, Summerside, PE',
        lat: 46.3959,
        lon: -63.7876,
        apptStart: now - 14 * 3600_000,
        apptEnd: now - 12 * 3600_000,
        arrivedAt: now - 14 * 3600_000,
        departedAt: now - 12.5 * 3600_000,
      },
      {
        id: 'stop_9948_2',
        loadId: 'load_9948',
        seq: 2,
        stopType: 'border_crossing',
        facilityName: 'CBP Calais / St. Stephen Port 0115',
        address: '1 International Ave, Calais, ME',
        lat: 45.1889,
        lon: -67.2784,
        apptStart: now - 3600_000,
        apptEnd: now + 3600_000,
        arrivedAt: now - 1200_000,
      },
      {
        id: 'stop_9948_3',
        loadId: 'load_9948',
        seq: 3,
        stopType: 'delivery',
        facilityName: 'New England Fresh Market Hub',
        address: '45 Terminal Way, Boston, MA',
        lat: 42.3601,
        lon: -71.0589,
        apptStart: now + 6 * 3600_000,
        apptEnd: now + 8 * 3600_000,
      },
    ])
    .onConflictDoNothing();

  await db
    .insert(customsManifests)
    .values([
      {
        id: 'man_9948',
        loadId: 'load_9948',
        manifestType: 'ACE_PAPS',
        scacOrCarrierCode: 'BROP',
        controlNumber: 'BROP8843921',
        tripNumber: 'BROP20261120A',
        portCode: '0115',
        etaUtc: new Date(now + 3 * 3600_000).toISOString(),
        carmIorVerified: true,
        fdaPriorNoticeNum: 'FDA-PN-88439210',
        manifestJson: JSON.stringify({ commodity: 'Chilled PEI Potatoes', hsCode: '070190' }),
        validationReportJson: JSON.stringify({ compliant: true, errors: [], warnings: [] }),
        status: 'filed',
        createdAt: now - 4 * 3600_000,
        updatedAt: now,
      },
    ])
    .onConflictDoNothing();

  await db
    .insert(invoices)
    .values([
      {
        id: 'inv_9949',
        invoiceNumber: 'INV-2026-9949',
        loadId: 'load_9949',
        shipperOrgId: 'org_fundy_steel',
        currency: 'USD',
        lineItemsJson: JSON.stringify([
          { code: 'LH', description: 'Flatbed Linehaul (Albany NY -> Moncton NB)', quantity: 1, unitPriceCents: 440000, amountCents: 440000 },
          { code: 'DET', description: 'Detention (45 min billable @ $85/hr)', quantity: 1, unitPriceCents: 6375, amountCents: 6375 },
          { code: 'TARP', description: '8ft Drop Heavy Weather Tarping', quantity: 1, unitPriceCents: 15000, amountCents: 15000 },
        ]),
        subtotalCents: 461375,
        taxCents: 0,
        taxLabel: 'Zero-Rated International Freight (0%)',
        totalCents: 461375,
        status: 'pending_approval',
        dueDate: now + 30 * day,
        createdAt: now - 1800_000,
        updatedAt: now - 1800_000,
      },
    ])
    .onConflictDoNothing();

  await db
    .insert(iftaLogs)
    .values([
      { id: 'ifta_1', loadId: 'load_9948', tractorId: 'eq_trc_101', quarter: '2026-Q4', jurisdictionCode: 'PE', distanceKm: 112, fuelLiters: 180, fuelCostCents: 31000, createdAt: now },
      { id: 'ifta_2', loadId: 'load_9948', tractorId: 'eq_trc_101', quarter: '2026-Q4', jurisdictionCode: 'NB', distanceKm: 285, fuelLiters: 220, fuelCostCents: 37800, createdAt: now },
      { id: 'ifta_3', loadId: 'load_9948', tractorId: 'eq_trc_101', quarter: '2026-Q4', jurisdictionCode: 'ME', distanceKm: 410, fuelLiters: 190, fuelCostCents: 29200, createdAt: now },
      { id: 'ifta_4', loadId: 'load_9948', tractorId: 'eq_trc_101', quarter: '2026-Q4', jurisdictionCode: 'MA', distanceKm: 135, fuelLiters: 0, fuelCostCents: 0, createdAt: now },
    ])
    .onConflictDoNothing();

  await db
    .insert(telematicsEvents)
    .values([
      {
        id: 'tel_seed_1',
        equipmentId: 'eq_rf_4221',
        loadId: 'load_9948',
        lat: 45.1889,
        lon: -67.2784,
        reeferTempC: 4.1,
        setpointC: 4.0,
        doorClosed: true,
        axleWeightKg: 31400,
        tpmsPsi: 108,
        vibrationHz: 12.4,
        weibullHazard: 0.00018,
        failureRiskPct: 4.9,
        rulHours: 4920,
        recordedAt: now,
      },
    ])
    .onConflictDoNothing();

  await db
    .insert(auditLogs)
    .values([
      {
        id: 'aud_seed_1',
        actorType: 'system',
        action: 'DB_SEED_INITIALIZED',
        entityType: 'system',
        entityId: 'brotransport-db',
        detailJson: JSON.stringify({ version: '1.0.0' }),
        createdAt: now,
      },
    ])
    .onConflictDoNothing();
}
