import { sqliteTable, text, integer, real, index } from 'drizzle-orm/sqlite-core';

// 1. Organizations (Shippers, Partner Carriers, Factoring Companies)
export const organizations = sqliteTable(
  'organizations',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    type: text('type', { enum: ['shipper', 'carrier', 'factor', 'internal'] }).notNull(),
    usdot: text('usdot'),
    mcNumber: text('mc_number'),
    scac: text('scac'),
    craBnRm: text('cra_bn_rm'),
    carmRppVerified: integer('carm_rpp_verified', { mode: 'boolean' }).notNull().default(false),
    currency: text('currency', { enum: ['CAD', 'USD'] }).notNull().default('CAD'),
    paymentTermsDays: integer('payment_terms_days').notNull().default(30),
    billingEmail: text('billing_email'),
    phone: text('phone'),
    address: text('address'),
    fmcsaSnapshotJson: text('fmcsa_snapshot_json'),
    status: text('status', { enum: ['pending', 'active', 'suspended', 'rejected'] }).notNull().default('pending'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('idx_orgs_usdot').on(t.usdot), index('idx_orgs_type').on(t.type)],
);

// 2. Users (Better Auth compatible + Dual-Portal RBAC)
export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    email: text('email').notNull().unique(),
    emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
    image: text('image'),
    role: text('role', {
      enum: [
        'visitor',
        'shipper_user',
        'shipper_admin',
        'carrier_driver',
        'dispatcher',
        'customs_broker',
        'billing_clerk',
        'safety_officer',
        'super_admin',
      ],
    })
      .notNull()
      .default('shipper_user'),
    organizationId: text('organization_id').references(() => organizations.id),
    phone: text('phone'),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('idx_users_role').on(t.role), index('idx_users_org').on(t.organizationId)],
);

// 3. Sessions (Better Auth)
export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    expiresAt: integer('expires_at').notNull(),
    token: text('token').notNull().unique(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('idx_sessions_user').on(t.userId)],
);

// 4. Accounts & Verifications (Better Auth credentials/OTP/Passkeys)
export const accounts = sqliteTable('accounts', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  password: text('password'),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  expiresAt: integer('expires_at'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const verifications = sqliteTable('verifications', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: integer('expires_at').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const passkeys = sqliteTable('passkeys', {
  id: text('id').primaryKey(),
  name: text('name'),
  publicKey: text('public_key').notNull(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  credentialID: text('credential_id').notNull().unique(),
  counter: integer('counter').notNull().default(0),
  deviceType: text('device_type').notNull(),
  backedUp: integer('backed_up', { mode: 'boolean' }).notNull().default(false),
  transports: text('transports'),
  createdAt: integer('created_at').notNull(),
});

// 5. Drivers
export const drivers = sqliteTable(
  'drivers',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').references(() => users.id),
    organizationId: text('organization_id').references(() => organizations.id),
    fullName: text('full_name').notNull(),
    phone: text('phone').notNull(),
    email: text('email').notNull(),
    equipmentDivision: text('equipment_division', { enum: ['dry_van', 'reefer', 'flatbed'] }).notNull(),
    preferredLanes: text('preferred_lanes').notNull(),
    licenseNumber: text('license_number'),
    licenseClass: text('license_class').default('Class 1 / AZ'),
    licenseExpiry: integer('license_expiry'),
    medicalCardExpiry: integer('medical_card_expiry'),
    fastCardNumber: text('fast_card_number'),
    payModel: text('pay_model', { enum: ['cpm', 'percent_gross'] }).notNull().default('cpm'),
    payRateValue: integer('pay_rate_value').notNull().default(68), // cents/mi or bps
    status: text('status', { enum: ['applicant', 'active', 'on_leave', 'inactive'] }).notNull().default('applicant'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('idx_drivers_status').on(t.status)],
);

// 6. Equipment (Tractors & Commercial Trailers)
export const equipment = sqliteTable(
  'equipment',
  {
    id: text('id').primaryKey(),
    unitNumber: text('unit_number').notNull().unique(),
    type: text('type', { enum: ['tractor', 'dry_van', 'reefer', 'flatbed'] }).notNull(),
    vin: text('vin').notNull(),
    plate: text('plate').notNull(),
    jurisdiction: text('jurisdiction').notNull(),
    gvwrKg: integer('gvwr_kg').notNull().default(36287),
    operatingHours: integer('operating_hours').notNull().default(1200),
    annualInspectionExpiry: integer('annual_inspection_expiry').notNull(),
    status: text('status', { enum: ['active', 'maintenance', 'out_of_service'] }).notNull().default('active'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('idx_equip_status').on(t.status)],
);

// 7. Quotes
export const quotes = sqliteTable(
  'quotes',
  {
    id: text('id').primaryKey(),
    quoteRef: text('quote_ref').notNull().unique(),
    shipperOrgId: text('shipper_org_id').references(() => organizations.id),
    equipmentType: text('equipment_type', { enum: ['dry_van', 'reefer', 'flatbed'] }).notNull(),
    originLabel: text('origin_label').notNull(),
    originCountry: text('origin_country').notNull(),
    originLat: real('origin_lat').notNull(),
    originLon: real('origin_lon').notNull(),
    destLabel: text('dest_label').notNull(),
    destCountry: text('dest_country').notNull(),
    destLat: real('dest_lat').notNull(),
    destLon: real('dest_lon').notNull(),
    distanceKm: integer('distance_km').notNull(),
    weightLbs: integer('weight_lbs').notNull(),
    commodity: text('commodity').notNull(),
    tempSetpointC: real('temp_setpoint_c'),
    accessorialsJson: text('accessorials_json').notNull(),
    linehaulCents: integer('linehaul_cents').notNull(),
    fscCents: integer('fsc_cents').notNull(),
    customsCents: integer('customs_cents').notNull(),
    accessorialsCents: integer('accessorials_cents').notNull(),
    totalCents: integer('total_cents').notNull(),
    currency: text('currency', { enum: ['CAD', 'USD'] }).notNull().default('CAD'),
    co2Kg: integer('co2_kg').notNull(),
    recommendedPortCode: text('recommended_port_code'),
    contactName: text('contact_name').notNull(),
    contactEmail: text('contact_email').notNull(),
    contactPhone: text('contact_phone').notNull(),
    status: text('status', { enum: ['open', 'booked', 'expired'] }).notNull().default('open'),
    expiresAt: integer('expires_at').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('idx_quotes_ref').on(t.quoteRef)],
);

// 8. Loads (Master TMS 11-State Lifecycle)
export const loads = sqliteTable(
  'loads',
  {
    id: text('id').primaryKey(),
    loadNumber: text('load_number').notNull().unique(),
    quoteId: text('quote_id').references(() => quotes.id),
    shipperOrgId: text('shipper_org_id')
      .notNull()
      .references(() => organizations.id),
    assignedDriverId: text('assigned_driver_id').references(() => drivers.id),
    tractorId: text('tractor_id').references(() => equipment.id),
    trailerId: text('trailer_id').references(() => equipment.id),
    equipmentType: text('equipment_type', { enum: ['dry_van', 'reefer', 'flatbed'] }).notNull(),
    direction: text('direction', { enum: ['domestic_ca', 'domestic_us', 'ca_to_us', 'us_to_ca'] }).notNull(),
    status: text('status', {
      enum: [
        'QUOTED',
        'BOOKED',
        'DISPATCHED',
        'AT_PICKUP',
        'IN_TRANSIT',
        'AT_BORDER',
        'CLEARED',
        'AT_DELIVERY',
        'DELIVERED',
        'INVOICED',
        'PAID',
      ],
    })
      .notNull()
      .default('BOOKED'),
    commodity: text('commodity').notNull(),
    weightLbs: integer('weight_lbs').notNull(),
    loadedMiles: integer('loaded_miles').notNull().default(450),
    tempSetpointC: real('temp_setpoint_c'),
    isFoodFda: integer('is_food_fda', { mode: 'boolean' }).notNull().default(false),
    rateCustomerCents: integer('rate_customer_cents').notNull(),
    rateCarrierCents: integer('rate_carrier_cents').notNull().default(0),
    currency: text('currency', { enum: ['CAD', 'USD'] }).notNull().default('CAD'),
    detentionMinutes: integer('detention_minutes').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    index('idx_loads_status').on(t.status),
    index('idx_loads_shipper').on(t.shipperOrgId),
    index('idx_loads_driver').on(t.assignedDriverId),
  ],
);

// 9. Load Stops
export const loadStops = sqliteTable(
  'load_stops',
  {
    id: text('id').primaryKey(),
    loadId: text('load_id')
      .notNull()
      .references(() => loads.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    stopType: text('stop_type', { enum: ['pickup', 'border_crossing', 'delivery'] }).notNull(),
    facilityName: text('facility_name').notNull(),
    address: text('address').notNull(),
    lat: real('lat').notNull(),
    lon: real('lon').notNull(),
    apptStart: integer('appt_start').notNull(),
    apptEnd: integer('appt_end').notNull(),
    arrivedAt: integer('arrived_at'),
    departedAt: integer('departed_at'),
  },
  (t) => [index('idx_stops_load').on(t.loadId)],
);

// 10. Documents (R2 Archive + AI OCR + HITL Status)
export const documents = sqliteTable(
  'documents',
  {
    id: text('id').primaryKey(),
    loadId: text('load_id').references(() => loads.id),
    driverId: text('driver_id').references(() => drivers.id),
    orgId: text('org_id').references(() => organizations.id),
    uploadedByUserId: text('uploaded_by_user_id').references(() => users.id),
    docType: text('doc_type').notNull(),
    r2Key: text('r2_key').notNull(),
    originalFilename: text('original_filename').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    sha256Hex: text('sha256_hex').notNull(),
    ocrStatus: text('ocr_status', {
      enum: ['pending', 'extracting', 'awaiting_review', 'verified', 'rejected'],
    })
      .notNull()
      .default('pending'),
    ocrJson: text('ocr_json'),
    ocrConfidence: real('ocr_confidence'),
    reviewNotes: text('review_notes'),
    verifiedBy: text('verified_by').references(() => users.id),
    verifiedAt: integer('verified_at'),
    workflowInstanceId: text('workflow_instance_id'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('idx_docs_load').on(t.loadId), index('idx_docs_ocr_status').on(t.ocrStatus)],
);

// 11. Cross-Border Customs Manifests (ACE PAPS / ACI PARS / CARM / RNS)
export const customsManifests = sqliteTable(
  'customs_manifests',
  {
    id: text('id').primaryKey(),
    loadId: text('load_id').references(() => loads.id),
    manifestType: text('manifest_type', { enum: ['ACE_PAPS', 'ACI_PARS'] }).notNull(),
    scacOrCarrierCode: text('scac_or_carrier_code').notNull(),
    controlNumber: text('control_number').notNull().unique(),
    tripNumber: text('trip_number').notNull(),
    portCode: text('port_code').notNull(),
    etaUtc: text('eta_utc').notNull(),
    carmIorVerified: integer('carm_ior_verified', { mode: 'boolean' }).notNull().default(false),
    fdaPriorNoticeNum: text('fda_prior_notice_num'),
    manifestJson: text('manifest_json').notNull(),
    validationReportJson: text('validation_report_json').notNull(),
    status: text('status', { enum: ['draft', 'validated', 'filed', 'released', 'held'] })
      .notNull()
      .default('draft'),
    rnsReleasedAt: integer('rns_released_at'),
    coverSheetR2Key: text('cover_sheet_r2_key'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('idx_customs_load').on(t.loadId), index('idx_customs_ctrl').on(t.controlNumber)],
);

// 12. Cryptographic eBOL Append-Only Chain (ECDSA P-256)
export const ebolBlocks = sqliteTable(
  'ebol_blocks',
  {
    id: text('id').primaryKey(),
    loadId: text('load_id').notNull(),
    seq: integer('seq').notNull(),
    stage: text('stage', {
      enum: ['SHIPPER_INIT', 'CARRIER_PICKUP', 'IN_TRANSIT_CHECKPOINT', 'CONSIGNEE_POD'],
    }).notNull(),
    actorRole: text('actor_role').notNull(),
    actorName: text('actor_name').notNull(),
    signerPublicKeyJwk: text('signer_public_key_jwk').notNull(),
    payloadJson: text('payload_json').notNull(),
    payloadSha256: text('payload_sha256').notNull(),
    prevHash: text('prev_hash').notNull(),
    blockHash: text('block_hash').notNull(),
    ecdsaSignatureB64: text('ecdsa_signature_b64').notNull(),
    gpsLat: real('gps_lat').notNull(),
    gpsLon: real('gps_lon').notNull(),
    signedAt: integer('signed_at').notNull(),
  },
  (t) => [index('idx_ebol_load_seq').on(t.loadId, t.seq)],
);

// 13. Invoices & Factoring Packets (AR)
export const invoices = sqliteTable(
  'invoices',
  {
    id: text('id').primaryKey(),
    invoiceNumber: text('invoice_number').notNull().unique(),
    loadId: text('load_id')
      .notNull()
      .references(() => loads.id),
    shipperOrgId: text('shipper_org_id')
      .notNull()
      .references(() => organizations.id),
    currency: text('currency', { enum: ['CAD', 'USD'] }).notNull().default('CAD'),
    lineItemsJson: text('line_items_json').notNull(),
    subtotalCents: integer('subtotal_cents').notNull(),
    taxCents: integer('tax_cents').notNull(),
    taxLabel: text('tax_label').notNull(),
    totalCents: integer('total_cents').notNull(),
    status: text('status', {
      enum: ['draft', 'pending_approval', 'sent', 'partially_paid', 'paid', 'disputed', 'factored'],
    })
      .notNull()
      .default('pending_approval'),
    dueDate: integer('due_date').notNull(),
    paidAt: integer('paid_at'),
    paymentRef: text('payment_ref'),
    invoicePdfR2Key: text('invoice_pdf_r2_key'),
    factoringPacketR2Key: text('factoring_packet_r2_key'),
    stripePaymentUrl: text('stripe_payment_url'),
    workflowInstanceId: text('workflow_instance_id'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('idx_inv_org').on(t.shipperOrgId), index('idx_inv_status').on(t.status)],
);

// 14. Driver Settlements (Payroll)
export const driverSettlements = sqliteTable(
  'driver_settlements',
  {
    id: text('id').primaryKey(),
    settlementNumber: text('settlement_number').notNull().unique(),
    driverId: text('driver_id')
      .notNull()
      .references(() => drivers.id),
    periodStart: integer('period_start').notNull(),
    periodEnd: integer('period_end').notNull(),
    loadsJson: text('loads_json').notNull(),
    deductionsJson: text('deductions_json').notNull(),
    grossPayCents: integer('gross_pay_cents').notNull(),
    reimbursementsCents: integer('reimbursements_cents').notNull().default(0),
    deductionsCents: integer('deductions_cents').notNull().default(0),
    netPayCents: integer('net_pay_cents').notNull(),
    currency: text('currency', { enum: ['CAD', 'USD'] }).notNull().default('CAD'),
    status: text('status', { enum: ['draft', 'finalized', 'paid'] }).notNull().default('draft'),
    pdfR2Key: text('pdf_r2_key'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('idx_settle_driver').on(t.driverId)],
);

// 15. IFTA Jurisdiction Mileage & Fuel Logs
export const iftaLogs = sqliteTable(
  'ifta_logs',
  {
    id: text('id').primaryKey(),
    loadId: text('load_id').references(() => loads.id),
    tractorId: text('tractor_id')
      .notNull()
      .references(() => equipment.id),
    quarter: text('quarter').notNull(),
    jurisdictionCode: text('jurisdiction_code').notNull(),
    distanceKm: real('distance_km').notNull(),
    fuelLiters: real('fuel_liters').notNull().default(0),
    fuelCostCents: integer('fuel_cost_cents').notNull().default(0),
    receiptDocId: text('receipt_doc_id').references(() => documents.id),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('idx_ifta_quarter').on(t.quarter)],
);

// 16. Digital DVIR Inspections
export const dvirInspections = sqliteTable(
  'dvir_inspections',
  {
    id: text('id').primaryKey(),
    driverId: text('driver_id')
      .notNull()
      .references(() => drivers.id),
    tractorId: text('tractor_id')
      .notNull()
      .references(() => equipment.id),
    trailerId: text('trailer_id').references(() => equipment.id),
    inspectionType: text('inspection_type', { enum: ['pre_trip', 'post_trip'] }).notNull(),
    odometerKm: integer('odometer_km').notNull(),
    checklistJson: text('checklist_json').notNull(),
    defectsFound: integer('defects_found', { mode: 'boolean' }).notNull().default(false),
    safeToOperate: integer('safe_to_operate', { mode: 'boolean' }).notNull().default(true),
    driverSignatureName: text('driver_signature_name').notNull(),
    signedAt: integer('signed_at').notNull(),
    mechanicClearedBy: text('mechanic_cleared_by').references(() => users.id),
    mechanicClearedAt: integer('mechanic_cleared_at'),
  },
  (t) => [index('idx_dvir_tractor').on(t.tractorId)],
);

// 17. Time-Series Telematics & Weibull-Cox RUL Snapshots
export const telematicsEvents = sqliteTable(
  'telematics_events',
  {
    id: text('id').primaryKey(),
    equipmentId: text('equipment_id')
      .notNull()
      .references(() => equipment.id),
    loadId: text('load_id').references(() => loads.id),
    lat: real('lat').notNull(),
    lon: real('lon').notNull(),
    reeferTempC: real('reefer_temp_c'),
    setpointC: real('setpoint_c'),
    doorClosed: integer('door_closed', { mode: 'boolean' }),
    axleWeightKg: integer('axle_weight_kg'),
    tpmsPsi: integer('tpms_psi'),
    vibrationHz: real('vibration_hz'),
    weibullHazard: real('weibull_hazard'),
    failureRiskPct: real('failure_risk_pct'),
    rulHours: integer('rul_hours'),
    recordedAt: integer('recorded_at').notNull(),
  },
  (t) => [index('idx_tel_equip_time').on(t.equipmentId, t.recordedAt)],
);

// 18. EDI Messages, Priority Escalations & Immutable Audit Logs
export const ediMessages = sqliteTable(
  'edi_messages',
  {
    id: text('id').primaryKey(),
    loadId: text('load_id').references(() => loads.id),
    transactionSet: text('transaction_set', { enum: ['204', '990', '214', '210', '997'] }).notNull(),
    direction: text('direction', { enum: ['inbound', 'outbound'] }).notNull(),
    controlNumber: text('control_number').notNull(),
    rawX12: text('raw_x12').notNull(),
    parsedJson: text('parsed_json'),
    status: text('status', { enum: ['received', 'processed', 'sent', 'failed'] }).notNull().default('received'),
    ack997Received: integer('ack_997_received', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('idx_edi_load').on(t.loadId)],
);

export const escalations = sqliteTable(
  'escalations',
  {
    id: text('id').primaryKey(),
    incidentRef: text('incident_ref').notNull().unique(),
    category: text('category', {
      enum: ['border_hold', 'cold_chain_excursion', 'roadside_intercept', 'urgent_capacity'],
    }).notNull(),
    severity: text('severity', { enum: ['high', 'critical'] }).notNull().default('high'),
    loadReference: text('load_reference'),
    contactName: text('contact_name').notNull(),
    contactChannel: text('contact_channel').notNull(),
    summary: text('summary').notNull(),
    status: text('status', { enum: ['open', 'acknowledged', 'resolved'] }).notNull().default('open'),
    assignedTo: text('assigned_to').references(() => users.id),
    slaDeadline: integer('sla_deadline').notNull(),
    resolvedAt: integer('resolved_at'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('idx_esc_status').on(t.status)],
);

export const auditLogs = sqliteTable(
  'audit_logs',
  {
    id: text('id').primaryKey(),
    actorUserId: text('actor_user_id'),
    actorType: text('actor_type', { enum: ['user', 'agent', 'workflow', 'webhook', 'system'] }).notNull(),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    detailJson: text('detail_json'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('idx_audit_entity').on(t.entityType, t.entityId)],
);
