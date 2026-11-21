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
  workOrders,
  loadCheckCalls,
  agentActions,
  auditLogs,
} from './schema.js';

/**
 * Deterministic seed dataset for local development and demo verification.
 * Uses authentic Atlantic Canada <-> North America commercial lanes (zero cliché placeholder names).
 * Security: Zero passwords inserted into `accounts` for seeded identities.
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

  const seedUsers = [
      {
        id: 'usr_admin_01',
        name: 'Keshav Operations Admin',
        email: 'admin@brotransport.com',
        emailVerified: true,
        role: 'super_admin' as const,
        title: 'Operations & Platform Admin',
        organizationId: 'org_bro_internal',
        phone: '902-555-0101',
        mustChangePassword: false,
        active: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'usr_disp_01',
        name: 'Claire Arsenault',
        email: 'dispatch@brotransport.com',
        emailVerified: true,
        role: 'dispatcher' as const,
        title: 'Lead Cross-Border Dispatcher',
        organizationId: 'org_bro_internal',
        phone: '902-555-0102',
        mustChangePassword: false,
        active: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'usr_planner_01',
        name: 'Marcus Belliveau',
        email: 'planner@brotransport.com',
        emailVerified: true,
        role: 'load_planner' as const,
        title: 'Senior Corridor Load Planner',
        organizationId: 'org_bro_internal',
        phone: '902-555-0103',
        mustChangePassword: false,
        active: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'usr_customs_01',
        name: 'Genevieve Poirier',
        email: 'customs@brotransport.com',
        emailVerified: true,
        role: 'customs_broker' as const,
        title: 'Licensed CBSA / CBP Customs Broker',
        organizationId: 'org_bro_internal',
        phone: '506-555-0104',
        mustChangePassword: false,
        active: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'usr_billing_01',
        name: 'Hannah MacKinnon',
        email: 'billing@brotransport.com',
        emailVerified: true,
        role: 'billing_clerk' as const,
        title: 'Freight AR & IFTA Billing Clerk',
        organizationId: 'org_bro_internal',
        phone: '902-555-0105',
        mustChangePassword: false,
        active: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'usr_settle_01',
        name: 'Trevor Cormier',
        email: 'settlements@brotransport.com',
        emailVerified: true,
        role: 'settlement_clerk' as const,
        title: 'Driver Payroll & Settlement Specialist',
        organizationId: 'org_bro_internal',
        phone: '506-555-0106',
        mustChangePassword: false,
        active: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'usr_safety_01',
        name: 'Danielle Gaudet',
        email: 'safety@brotransport.com',
        emailVerified: true,
        role: 'safety_officer' as const,
        title: 'DOT / NSC Fleet Safety Officer',
        organizationId: 'org_bro_internal',
        phone: '902-555-0107',
        mustChangePassword: false,
        active: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'usr_maint_01',
        name: 'Marc-Andre Leblanc',
        email: 'maintenance@brotransport.com',
        emailVerified: true,
        role: 'maintenance_manager' as const,
        title: 'Class-8 Shop & Maintenance Manager',
        organizationId: 'org_bro_internal',
        phone: '506-555-0108',
        mustChangePassword: false,
        active: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'usr_recruit_01',
        name: 'Sophie Thibodeau',
        email: 'recruiting@brotransport.com',
        emailVerified: true,
        role: 'carrier_recruiter' as const,
        title: 'Carrier & Driver Onboarding Lead',
        organizationId: 'org_bro_internal',
        phone: '902-555-0109',
        mustChangePassword: false,
        active: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'usr_night_01',
        name: 'Devon Chaisson',
        email: 'night@brotransport.com',
        emailVerified: true,
        role: 'night_coordinator' as const,
        title: 'Night Operations & Escalation Lead',
        organizationId: 'org_bro_internal',
        phone: '902-555-0110',
        mustChangePassword: false,
        active: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'usr_exec_01',
        name: 'Natalie Boudreau',
        email: 'exec@brotransport.com',
        emailVerified: true,
        role: 'executive' as const,
        title: 'VP Freight Operations & Finance',
        organizationId: 'org_bro_internal',
        phone: '902-555-0111',
        mustChangePassword: false,
        active: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'usr_shipper_01',
        name: 'Owen MacLeod',
        email: 'owen@cavendishvalley.example',
        emailVerified: true,
        role: 'shipper_admin' as const,
        title: 'VP Supply Chain',
        organizationId: 'org_cavendish_produce',
        phone: '902-555-0192',
        mustChangePassword: false,
        active: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'usr_driver_01',
        name: 'Liam Gallant',
        email: 'liam.gallant@brotransport.com',
        emailVerified: true,
        role: 'carrier_driver' as const,
        title: 'Company Reefer Operator',
        organizationId: 'org_bro_internal',
        phone: '902-555-0174',
        mustChangePassword: false,
        active: true,
        createdAt: now,
        updatedAt: now,
      },
  ];

  for (const u of seedUsers) {
    await db.insert(users).values(u).onConflictDoNothing();
  }

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
    .insert(workOrders)
    .values([
      {
        id: 'wo_seed_1',
        equipmentId: 'eq_fb_5022',
        unitNumber: 'FB-5022',
        priority: 'high',
        status: 'open',
        title: 'Annual CVIP Inspection & Brake Slack Adjuster Service',
        description:
          'Annual NSC/DOT safety inspection expires in 18 days. Inspect rear tandem air chambers, slack adjusters, and deck winches prior to next Moncton-Toronto dispatch.',
        estimatedCostCents: 68500,
        vendorName: 'Atlantic Heavy Fleet Services — Moncton',
        assignedMechanic: 'Marc-Andre Leblanc',
        createdAt: now - 6 * 3600_000,
        updatedAt: now - 3600_000,
      },
      {
        id: 'wo_seed_2',
        equipmentId: 'eq_rf_4221',
        unitNumber: 'RF-4221',
        priority: 'medium',
        status: 'in_progress',
        title: 'Thermo King Precedent S-600 Defrost Sensor Calibration',
        description:
          'Preventive calibration check on return-air thermistor and door seal integrity for cross-border FDA chilled produce lanes.',
        estimatedCostCents: 32000,
        vendorName: 'Charlottetown Reefer Bay 2',
        assignedMechanic: 'Marc-Andre Leblanc',
        createdAt: now - 12 * 3600_000,
        updatedAt: now - 1800_000,
      },
    ])
    .onConflictDoNothing();

  await db
    .insert(loadCheckCalls)
    .values([
      {
        id: 'cc_seed_1',
        loadId: 'load_9948',
        driverId: 'drv_01',
        recordedByUserId: 'usr_disp_01',
        recordedByType: 'dispatcher',
        statusNote:
          'Arrived at CBP Calais / St. Stephen Port 0115. ACE PAPS manifest BROP8843921 in queue; reefer setpoint +4.0C verified at +4.1C.',
        etaUtc: new Date(now + 6 * 3600_000).toISOString(),
        locationText: 'Calais, ME / St. Stephen, NB (Port 0115)',
        detentionMinutes: 0,
        createdAt: now - 1200_000,
      },
      {
        id: 'cc_seed_2',
        loadId: 'load_9949',
        driverId: 'drv_02',
        recordedByUserId: 'usr_night_01',
        recordedByType: 'night_coordinator',
        statusNote:
          'Unloaded galvanized structural steel I-beams at Moncton yard. 45 minutes billable detention logged beyond 2h free time.',
        etaUtc: new Date(now - 3600_000).toISOString(),
        locationText: '88 Caledonia Industrial Pkwy, Moncton, NB',
        detentionMinutes: 45,
        createdAt: now - 3600_000,
      },
    ])
    .onConflictDoNothing();

  const seedActions = [
      {
        id: 'agact_seed_1',
        agentId: 'CustomsPreFlightAgent',
        targetRole: 'customs_broker' as const,
        organizationId: 'org_cavendish_produce',
        entityType: 'customs_manifest',
        entityId: 'man_9948',
        actionType: 'PREFLIGHT_VERIFICATION',
        title: 'Verify FDA Prior Notice & CBP RNS Queue for BROP-2026-9948',
        rationale:
          'Load BROP-2026-9948 carrying perishable PEI potatoes & seafood at Port 0115 requires customs broker confirmation of FDA PN-88439210 prior to border release.',
        payloadJson: JSON.stringify({
          manifestId: 'man_9948',
          controlNumber: 'BROP8843921',
          portCode: '0115',
        }),
        deterministicPreviewJson: JSON.stringify({
          compliant: true,
          fdaLeadMinutes: 180,
          carmIorVerified: true,
        }),
        status: 'pending' as const,
        createdAt: now - 900_000,
      },
      {
        id: 'agact_seed_2',
        agentId: 'BillingCollectionsAgent',
        targetRole: 'billing_clerk' as const,
        organizationId: 'org_fundy_steel',
        entityType: 'invoice',
        entityId: 'inv_9949',
        actionType: 'APPROVE_AND_ISSUE_INVOICE',
        title: 'Approve & Issue Zero-Rated Invoice INV-2026-9949 ($4,613.75 USD)',
        rationale:
          'Delivered flatbed load BROP-2026-9949 includes 45 min detention ($63.75) and tarping ($150.00). Zero-rated under Canada ETA Schedule VI Part VII.',
        payloadJson: JSON.stringify({
          invoiceId: 'inv_9949',
          invoiceNumber: 'INV-2026-9949',
          nextStatus: 'sent',
        }),
        deterministicPreviewJson: JSON.stringify({
          subtotalCents: 461375,
          taxCents: 0,
          totalCents: 461375,
          currency: 'USD',
        }),
        status: 'pending' as const,
        createdAt: now - 800_000,
      },
      {
        id: 'agact_seed_3',
        agentId: 'SettlementAuditAgent',
        targetRole: 'settlement_clerk' as const,
        organizationId: 'org_bro_internal',
        entityType: 'load',
        entityId: 'load_9949',
        actionType: 'CREATE_SETTLEMENT_BATCH',
        title: 'Queue Driver Settlement Batch for Nadia Tremblay (BROP-2026-9949)',
        rationale:
          'Owner-operator load BROP-2026-9949 is DELIVERED with 82.00% gross contract split ($3,788.40 USD gross) ready for settlement batch verification.',
        payloadJson: JSON.stringify({
          driverId: 'drv_02',
          loadIds: ['load_9949'],
        }),
        deterministicPreviewJson: JSON.stringify({
          payModel: 'percent_gross',
          rateBps: 8200,
          grossPayCents: 378840,
          currency: 'USD',
        }),
        status: 'pending' as const,
        createdAt: now - 700_000,
      },
      {
        id: 'agact_seed_4',
        agentId: 'FleetWatchdogAgent',
        targetRole: 'safety_officer' as const,
        organizationId: 'org_bro_internal',
        entityType: 'driver',
        entityId: 'drv_01',
        actionType: 'COMPLIANCE_RENEWAL_NOTICE',
        title: 'Medical Certificate Expiring in 22 Days — Liam Gallant',
        rationale:
          '49 CFR § 391.45 medical card expires within the 30-day Fleet Watchdog threshold. Approve compliance notice dispatch to driver.',
        payloadJson: JSON.stringify({
          driverId: 'drv_01',
          daysRemaining: 22,
        }),
        deterministicPreviewJson: JSON.stringify({
          severity: 'ELEVATED',
          regulatoryCode: '49 CFR 391.45',
        }),
        status: 'pending' as const,
        createdAt: now - 600_000,
      },
      {
        id: 'agact_seed_5',
        agentId: 'ShopMaintenanceAgent',
        targetRole: 'maintenance_manager' as const,
        organizationId: 'org_bro_internal',
        entityType: 'work_order',
        entityId: 'wo_seed_1',
        actionType: 'ASSIGN_SHOP_BAY',
        title: 'Assign Moncton Bay 1 for Flatbed FB-5022 CVIP Inspection',
        rationale:
          'Equipment FB-5022 annual inspection expires in 18 days; work order wo_seed_1 ($685.00 est.) is open and ready for bay scheduling.',
        payloadJson: JSON.stringify({
          workOrderId: 'wo_seed_1',
          equipmentId: 'eq_fb_5022',
          unitNumber: 'FB-5022',
        }),
        deterministicPreviewJson: JSON.stringify({
          estimatedCostCents: 68500,
          daysUntilExpiry: 18,
        }),
        status: 'pending' as const,
        createdAt: now - 500_000,
      },
  ];

  for (const act of seedActions) {
    await db.insert(agentActions).values(act).onConflictDoNothing();
  }

  await db
    .insert(auditLogs)
    .values([
      {
        id: 'aud_seed_1',
        actorType: 'system',
        action: 'DB_SEED_INITIALIZED',
        entityType: 'system',
        entityId: 'brotransport-db',
        detailJson: JSON.stringify({ version: '2.0.0' }),
        createdAt: now,
      },
    ])
    .onConflictDoNothing();
}
