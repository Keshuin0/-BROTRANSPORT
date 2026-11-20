import { z } from 'zod';

export interface BorderPortInfo {
  cbpCode: string;
  cbsaName: string;
  crossingName: string;
  usCityState: string;
  caCityProv: string;
  lat: number;
  lon: number;
  highway: string;
  commercialFastLane: boolean;
}

export const NORTH_AMERICAN_PORTS: readonly BorderPortInfo[] = [
  {
    cbpCode: '0115',
    cbsaName: 'St. Stephen 3rd Bridge',
    crossingName: 'Calais, ME / St. Stephen, NB',
    usCityState: 'Calais, ME',
    caCityProv: 'St. Stephen, NB',
    lat: 45.1889,
    lon: -67.2784,
    highway: 'US-1 / NB-1',
    commercialFastLane: false,
  },
  {
    cbpCode: '0106',
    cbsaName: 'Woodstock Road',
    crossingName: 'Houlton, ME / Woodstock, NB',
    usCityState: 'Houlton, ME',
    caCityProv: 'Woodstock, NB',
    lat: 46.1342,
    lon: -67.7817,
    highway: 'I-95 / NB-95',
    commercialFastLane: true,
  },
  {
    cbpCode: '0712',
    cbsaName: 'St-Bernard-de-Lacolle',
    crossingName: 'Champlain, NY / Lacolle, QC',
    usCityState: 'Champlain, NY',
    caCityProv: 'St-Bernard-de-Lacolle, QC',
    lat: 45.0089,
    lon: -73.4525,
    highway: 'I-87 / QC-15',
    commercialFastLane: true,
  },
  {
    cbpCode: '0212',
    cbsaName: 'St-Armand/Philipsburg',
    crossingName: 'Highgate Springs, VT / St-Armand, QC',
    usCityState: 'Highgate Springs, VT',
    caCityProv: 'St-Armand, QC',
    lat: 45.0156,
    lon: -73.0819,
    highway: 'I-89 / QC-133',
    commercialFastLane: false,
  },
  {
    cbpCode: '0708',
    cbsaName: 'Lansdowne',
    crossingName: 'Alexandria Bay, NY / Lansdowne, ON',
    usCityState: 'Alexandria Bay, NY',
    caCityProv: 'Lansdowne, ON',
    lat: 44.3476,
    lon: -75.9834,
    highway: 'I-81 / ON-137',
    commercialFastLane: true,
  },
  {
    cbpCode: '0901',
    cbsaName: 'Fort Erie (Peace Bridge)',
    crossingName: 'Buffalo, NY / Fort Erie, ON',
    usCityState: 'Buffalo, NY',
    caCityProv: 'Fort Erie, ON',
    lat: 42.9069,
    lon: -78.9056,
    highway: 'I-190 / QEW',
    commercialFastLane: true,
  },
  {
    cbpCode: '0906',
    cbsaName: 'Queenston-Lewiston Bridge',
    crossingName: 'Lewiston, NY / Queenston, ON',
    usCityState: 'Lewiston, NY',
    caCityProv: 'Niagara-on-the-Lake, ON',
    lat: 43.1531,
    lon: -79.0442,
    highway: 'I-190 / ON-405',
    commercialFastLane: true,
  },
  {
    cbpCode: '3801',
    cbsaName: 'Ambassador Bridge',
    crossingName: 'Detroit, MI / Windsor, ON (Ambassador)',
    usCityState: 'Detroit, MI',
    caCityProv: 'Windsor, ON',
    lat: 42.3119,
    lon: -83.0742,
    highway: 'I-75 / ON-401',
    commercialFastLane: true,
  },
  {
    cbpCode: '3807',
    cbsaName: 'Gordie Howe International Bridge',
    crossingName: 'Detroit, MI / Windsor, ON (Gordie Howe)',
    usCityState: 'Detroit, MI',
    caCityProv: 'Windsor, ON',
    lat: 42.2882,
    lon: -83.0964,
    highway: 'I-75 / ON-401',
    commercialFastLane: true,
  },
  {
    cbpCode: '3802',
    cbsaName: 'Sarnia (Blue Water Bridge)',
    crossingName: 'Port Huron, MI / Sarnia, ON',
    usCityState: 'Port Huron, MI',
    caCityProv: 'Point Edward, ON',
    lat: 42.9986,
    lon: -82.4236,
    highway: 'I-69 / ON-402',
    commercialFastLane: true,
  },
  {
    cbpCode: '3401',
    cbsaName: 'Emerson',
    crossingName: 'Pembina, ND / Emerson, MB',
    usCityState: 'Pembina, ND',
    caCityProv: 'Emerson, MB',
    lat: 49.0001,
    lon: -97.2374,
    highway: 'I-29 / MB-75',
    commercialFastLane: true,
  },
  {
    cbpCode: '3004',
    cbsaName: 'Pacific Highway',
    crossingName: 'Blaine, WA / Surrey, BC',
    usCityState: 'Blaine, WA',
    caCityProv: 'Surrey, BC',
    lat: 49.0021,
    lon: -122.7354,
    highway: 'I-5 / BC-15',
    commercialFastLane: true,
  },
  {
    cbpCode: '2304',
    cbsaName: 'Laredo World Trade Bridge',
    crossingName: 'Laredo, TX / Nuevo Laredo, TM',
    usCityState: 'Laredo, TX',
    caCityProv: 'Nuevo Laredo, MX',
    lat: 27.5973,
    lon: -99.5372,
    highway: 'I-35 / MEX-85D',
    commercialFastLane: true,
  },
] as const;

const VIN_TRANSLITERATION: Record<string, number> = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8,
  J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
  S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
  '0': 0, '1': 1, '2': 2, '3': 3, '4': 4,
  '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
};

const VIN_WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2] as const;

/**
 * Real ISO 3779 17-character VIN check-digit validation.
 */
export function validateVin(rawVin: string): boolean {
  const vin = rawVin.trim().toUpperCase();
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) return false;

  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const val = VIN_TRANSLITERATION[vin[i]];
    if (val === undefined) return false;
    sum += val * VIN_WEIGHTS[i];
  }
  const remainder = sum % 11;
  const expected = remainder === 10 ? 'X' : String(remainder);
  return vin[8] === expected;
}

export const CustomsManifestTypeSchema = z.enum(['ACE_PAPS', 'ACI_PARS']);
export type CustomsManifestType = z.infer<typeof CustomsManifestTypeSchema>;

export const CustomsShipmentItemSchema = z.object({
  commodity: z.string().trim().min(2),
  hsCode: z.string().regex(/^\d{6,10}$/, { error: 'HS/HTS code must be 6 to 10 digits.' }),
  countryOfOrigin: z.enum(['CA', 'US', 'MX', 'OTHER']),
  cusmaCertOnFile: z.boolean().default(true),
  invoiceValueCents: z.number().int().min(100),
  currency: z.enum(['CAD', 'USD']),
  weightKg: z.number().positive(),
  quantity: z.number().int().positive(),
  packageType: z.string().trim().min(2),
  isFoodFda: z.boolean().default(false),
  shipperName: z.string().trim().min(2),
  shipperAddress: z.string().trim().min(4),
  consigneeName: z.string().trim().min(2),
  consigneeAddress: z.string().trim().min(4),
});

export const CustomsManifestInputSchema = z.object({
  loadId: z.string().optional(),
  manifestType: CustomsManifestTypeSchema,
  scacOrCarrierCode: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{4}$/, { error: 'SCAC / CBSA Carrier Code must be exactly 4 alphanumeric characters.' }),
  controlNumber: z.string().trim().toUpperCase().min(8).max(25),
  tripNumber: z.string().trim().toUpperCase().min(6).max(25),
  portCode: z.string().trim().min(4).max(6),
  etaUtc: z.string().datetime({ error: 'ETA must be a valid ISO-8601 UTC timestamp.' }),
  conveyance: z.object({
    vin: z.string().trim().toUpperCase().length(17),
    plate: z.string().trim().min(3).max(12),
    jurisdiction: z.string().trim().toUpperCase().length(2),
  }),
  crew: z
    .array(
      z.object({
        fastCardNumber: z.string().trim(),
        firstName: z.string().trim().min(1),
        lastName: z.string().trim().min(1),
        dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      }),
    )
    .min(1),
  carmIorAccountVerified: z.boolean().default(false),
  carmImporterBnRm: z.string().trim().optional(),
  fdaPriorNoticeNumber: z.string().trim().optional(),
  overweightPermitNumber: z.string().trim().optional(),
  shipments: z.array(CustomsShipmentItemSchema).min(1),
});

export type CustomsManifestInput = z.infer<typeof CustomsManifestInputSchema>;

export interface CustomsValidationReport {
  compliant: boolean;
  manifestId: string;
  portName: string;
  leadTimeMinutes: number;
  requiredLeadTimeMinutes: number;
  errors: string[];
  warnings: string[];
  checks: Array<{ code: string; label: string; status: 'pass' | 'warn' | 'fail'; detail: string }>;
}

/**
 * Deterministic 2026 CBP ACE PAPS & CBSA ACI PARS / CARM Release 2 compliance validator.
 */
export function validateCustomsManifest(
  manifest: CustomsManifestInput,
  nowUtcMs = Date.now(),
): CustomsValidationReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const checks: CustomsValidationReport['checks'] = [];

  // 1. Control number prefix check
  const prefixMatches = manifest.controlNumber.startsWith(manifest.scacOrCarrierCode);
  if (!prefixMatches) {
    errors.push(
      `Control number '${manifest.controlNumber}' must begin with carrier code '${manifest.scacOrCarrierCode}'.`,
    );
  }
  checks.push({
    code: 'CARRIER_PREFIX',
    label: 'SCAC / Carrier Code Prefix',
    status: prefixMatches ? 'pass' : 'fail',
    detail: prefixMatches ? `Prefix ${manifest.scacOrCarrierCode} verified.` : 'Prefix mismatch.',
  });

  // 2. Port directory lookup
  const port = NORTH_AMERICAN_PORTS.find((p) => p.cbpCode === manifest.portCode);
  const portName = port ? port.crossingName : `Port ${manifest.portCode}`;
  if (!port) {
    warnings.push(`Port code '${manifest.portCode}' is outside standard primary commercial crossings directory.`);
  }
  checks.push({
    code: 'PORT_DIRECTORY',
    label: 'Commercial Port of Entry',
    status: port ? 'pass' : 'warn',
    detail: port ? `${port.crossingName} (${port.highway})` : 'Unlisted secondary port code.',
  });

  // 3. ISO 3779 VIN check digit
  const vinValid = validateVin(manifest.conveyance.vin);
  if (!vinValid) {
    errors.push(`Conveyance VIN '${manifest.conveyance.vin}' failed ISO 3779 check-digit verification.`);
  }
  checks.push({
    code: 'ISO_3779_VIN',
    label: 'ISO 3779 VIN Check Digit',
    status: vinValid ? 'pass' : 'fail',
    detail: vinValid ? `VIN ${manifest.conveyance.vin} mathematically valid.` : 'Invalid check digit (char 9).',
  });

  // 4. Crew FAST Card format (9 digits)
  const badCrew = manifest.crew.filter((c) => !/^\d{9}$/.test(c.fastCardNumber));
  if (badCrew.length > 0) {
    badCrew.forEach((c) =>
      errors.push(`FAST Card for ${c.firstName} ${c.lastName} must be exactly 9 numeric digits.`),
    );
  }
  checks.push({
    code: 'CREW_FAST',
    label: 'Driver FAST Credentials',
    status: badCrew.length === 0 ? 'pass' : 'fail',
    detail: badCrew.length === 0 ? `${manifest.crew.length} crew credential(s) valid.` : 'Invalid FAST card format.',
  });

  // 5. Lead time check: 60 min standard, 120 min when FDA food enters US
  const hasFoodFda = manifest.shipments.some((s) => s.isFoodFda);
  const requiredLeadTimeMinutes = manifest.manifestType === 'ACE_PAPS' && hasFoodFda ? 120 : 60;
  const etaMs = Date.parse(manifest.etaUtc);
  const leadTimeMinutes = Math.round((etaMs - nowUtcMs) / 60000);
  if (leadTimeMinutes < requiredLeadTimeMinutes) {
    errors.push(
      `Pre-arrival window violated: ETA is ${leadTimeMinutes} min away (mandatory minimum ${requiredLeadTimeMinutes} min prior to arrival).`,
    );
  }
  checks.push({
    code: 'PRE_ARRIVAL_WINDOW',
    label: `Mandatory ${requiredLeadTimeMinutes}-Min Pre-Arrival Window`,
    status: leadTimeMinutes >= requiredLeadTimeMinutes ? 'pass' : 'fail',
    detail: `Lead time: ${leadTimeMinutes} min.`,
  });

  // 6. Southbound FDA Prior Notice (ACE_PAPS)
  if (manifest.manifestType === 'ACE_PAPS' && hasFoodFda) {
    const hasPn = Boolean(manifest.fdaPriorNoticeNumber && manifest.fdaPriorNoticeNumber.length >= 8);
    if (!hasPn) {
      errors.push('FDA Prior Notice confirmation number is mandatory for food/produce/seafood entering the United States.');
    }
    checks.push({
      code: 'FDA_PRIOR_NOTICE',
      label: 'FDA 2-Hour Prior Notice',
      status: hasPn ? 'pass' : 'fail',
      detail: hasPn ? `PN #${manifest.fdaPriorNoticeNumber}` : 'Missing FDA Prior Notice.',
    });
  }

  // 7. Northbound CARM Release 2 IOR RPP Bond Gate (ACI_PARS)
  if (manifest.manifestType === 'ACI_PARS') {
    const carmOk = manifest.carmIorAccountVerified === true;
    if (!carmOk) {
      errors.push(
        'CBSA CARM Release 2 Gate Failed: Importer of Record must have an active CARM Portal account and posted RPP bond prior to dispatch.',
      );
    }
    checks.push({
      code: 'CBSA_CARM_R2',
      label: 'CBSA CARM Release 2 IOR & RPP Bond',
      status: carmOk ? 'pass' : 'fail',
      detail: carmOk ? `IOR Verified (${manifest.carmImporterBnRm || 'RM Registered'})` : 'Unverified Importer of Record.',
    });
  }

  // 8. 2026 CUSMA / Tariff Surtax Warning
  const nonCusma = manifest.shipments.filter((s) => !s.cusmaCertOnFile || s.countryOfOrigin === 'OTHER');
  if (nonCusma.length > 0) {
    warnings.push(
      `${nonCusma.length} shipment line(s) lack CUSMA Certificate of Origin — subject to 2026 Section 338 / CBSA Customs Notice 26-23 surtax assessment.`,
    );
  }

  // 9. Aggregate weight limit (36,287 kg = 80,000 lbs standard 5-axle commercial)
  const totalWeightKg = manifest.shipments.reduce((sum, s) => sum + s.weightKg, 0);
  const weightOk = totalWeightKg <= 36287 || Boolean(manifest.overweightPermitNumber);
  if (!weightOk) {
    errors.push(
      `Total cargo weight ${totalWeightKg.toFixed(1)} kg exceeds 36,287 kg standard legal tandem limit without an overweight permit number.`,
    );
  }
  checks.push({
    code: 'GVW_LIMIT',
    label: 'Legal Tandem Weight Threshold',
    status: weightOk ? 'pass' : 'fail',
    detail: `${totalWeightKg.toFixed(1)} kg / 36,287.0 kg max.`,
  });

  return {
    compliant: errors.length === 0,
    manifestId: `${manifest.scacOrCarrierCode}-${manifest.tripNumber}`,
    portName,
    leadTimeMinutes,
    requiredLeadTimeMinutes,
    errors,
    warnings,
    checks,
  };
}
