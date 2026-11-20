import { z } from 'zod';

export const EquipmentTypeSchema = z.enum(['dry_van', 'reefer', 'flatbed']);
export type EquipmentType = z.infer<typeof EquipmentTypeSchema>;

export const CountryCodeSchema = z.enum(['CA', 'US', 'MX']);
export type CountryCode = z.infer<typeof CountryCodeSchema>;

export const CurrencySchema = z.enum(['CAD', 'USD']);
export type Currency = z.infer<typeof CurrencySchema>;

export const QuoteEstimateInputSchema = z.object({
  equipmentType: EquipmentTypeSchema,
  originCity: z.string().trim().min(2, { error: 'Origin city is required.' }),
  originProvinceState: z.string().trim().min(2).max(3),
  originCountry: CountryCodeSchema,
  originLat: z.number().min(14).max(72),
  originLon: z.number().min(-170).max(-50),
  destCity: z.string().trim().min(2, { error: 'Destination city is required.' }),
  destProvinceState: z.string().trim().min(2).max(3),
  destCountry: CountryCodeSchema,
  destLat: z.number().min(14).max(72),
  destLon: z.number().min(-170).max(-50),
  weightLbs: z.number().int().min(1, { error: 'Weight must be at least 1 lb.' }).max(45000, { error: 'Standard commercial limit is 45,000 lbs.' }),
  tempSetpointC: z.number().min(-30).max(25).optional(),
  requiresTarp: z.boolean().default(false),
  requiresStrapping: z.boolean().default(false),
  requiresTeamDriver: z.boolean().default(false),
  isHazmat: z.boolean().default(false),
  isFoodFda: z.boolean().default(false),
  currency: CurrencySchema.default('CAD'),
});

export const QuoteRequestSchema = QuoteEstimateInputSchema.extend({
  contactName: z.string().trim().min(2, { error: 'Representative name is required.' }),
  contactEmail: z.email({ error: 'Provide a valid corporate email address.' }),
  contactPhone: z.string().trim().min(10, { error: 'Provide a valid 10-digit phone number.' }),
  commodity: z.string().trim().min(2).max(120).default('General Commercial Freight'),
  turnstileToken: z.string().optional(),
});

export type QuoteEstimateInput = z.infer<typeof QuoteEstimateInputSchema>;
export type QuoteRequestInput = z.infer<typeof QuoteRequestSchema>;

export interface RateCalculationResult {
  distanceKm: number;
  distanceMiles: number;
  isCrossBorder: boolean;
  currency: Currency;
  linehaulCents: number;
  fuelSurchargeCents: number;
  customsBrokerageCents: number;
  accessorialsCents: number;
  accessorialBreakdown: Array<{ code: string; label: string; amountCents: number }>;
  demandMultiplier: number;
  subtotalCents: number;
  totalCents: number;
  estimatedTransitHours: number;
  co2Kg: number;
  recommendedEquipmentLabel: string;
}

const BASE_RATE_CENTS_PER_KM: Record<EquipmentType, number> = {
  dry_van: 215,
  reefer: 265,
  flatbed: 255,
};

const MIN_LINEHAUL_CENTS = 65000; // $650.00 minimum linehaul
const CAD_PER_USD_FX = 1.38;

/**
 * Pure deterministic freight rate & EPA SmartWay / GLEC carbon calculator.
 * All monetary outputs are integer cents — zero floating-point currency accumulation.
 */
export function calculateFreightRate(
  input: QuoteEstimateInput,
  distanceKmRaw: number,
  dieselPriceCadPerLiter = 1.72,
  loadToTruckRatio = 1.18,
  borderDelayMinutes = 15,
): RateCalculationResult {
  const distanceKm = Math.max(25, Math.round(distanceKmRaw));
  const distanceMiles = Math.round(distanceKm / 1.60934);
  const isCrossBorder = input.originCountry !== input.destCountry;

  // Bounded capacity demand multiplier [0.92, 1.35]
  const demandMultiplier = Number(
    Math.min(1.35, Math.max(0.92, 0.95 + (loadToTruckRatio - 1.0) * 0.45)).toFixed(3),
  );

  // Base linehaul in CAD cents
  const rawLinehaulCad = Math.max(
    MIN_LINEHAUL_CENTS,
    Math.round(distanceKm * BASE_RATE_CENTS_PER_KM[input.equipmentType] * demandMultiplier),
  );

  // Fuel surcharge: deterministic DOE/NRCan style peg above $1.35 CAD/L baseline (~35 L / 100 km)
  const dieselExcess = Math.max(0, dieselPriceCadPerLiter - 1.35);
  const fscPerKmCents = Math.round(dieselExcess * 35); // cents/km
  const reeferFuelFactor = input.equipmentType === 'reefer' ? 1.18 : 1.0;
  const fscCad = Math.round(distanceKm * fscPerKmCents * reeferFuelFactor);

  // Cross-border ACE/ACI customs coordination fee
  const customsCad = isCrossBorder ? 18500 : 0;

  // Itemized accessorials in CAD cents
  const accessorialBreakdownCad: Array<{ code: string; label: string; amountCents: number }> = [];
  if (input.equipmentType === 'reefer') {
    accessorialBreakdownCad.push({
      code: 'REEFER_COLD_CHAIN',
      label: `Continuous Cold-Chain Monitoring (${input.tempSetpointC ?? -18}°C)`,
      amountCents: 25000,
    });
  }
  if (input.equipmentType === 'flatbed' && input.requiresTarp) {
    accessorialBreakdownCad.push({
      code: 'FLATBED_TARP',
      label: '8ft Drop Heavy-Duty Weather Tarping',
      amountCents: 15000,
    });
  }
  if (input.equipmentType === 'flatbed' && input.requiresStrapping) {
    accessorialBreakdownCad.push({
      code: 'FLATBED_STRAPS',
      label: 'Chains, Binders & Strap Tension Securement',
      amountCents: 7500,
    });
  }
  if (input.weightLbs > 38000) {
    accessorialBreakdownCad.push({
      code: 'HEAVY_PAYLOAD',
      label: 'High-Density Payload (>38,000 lbs)',
      amountCents: 20000,
    });
  }
  if (input.requiresTeamDriver) {
    accessorialBreakdownCad.push({
      code: 'TEAM_EXPEDITE',
      label: 'Team-Driver Continuous Transit (+35% Linehaul)',
      amountCents: Math.round(rawLinehaulCad * 0.35),
    });
  }
  if (input.isHazmat) {
    accessorialBreakdownCad.push({
      code: 'HAZMAT_TDG',
      label: 'TDG / DOT Hazmat Placarded Compliance',
      amountCents: 35000,
    });
  }
  if (isCrossBorder && input.isFoodFda) {
    accessorialBreakdownCad.push({
      code: 'FDA_PRIOR_NOTICE',
      label: 'FDA 2-Hour Prior Notice / CFIA Perishable Filing',
      amountCents: 6500,
    });
  }

  const accessorialsCad = accessorialBreakdownCad.reduce((acc, item) => acc + item.amountCents, 0);

  const fxDivisor = input.currency === 'USD' ? CAD_PER_USD_FX : 1.0;
  const convert = (cadCents: number) => Math.round(cadCents / fxDivisor);

  const linehaulCents = convert(rawLinehaulCad);
  const fuelSurchargeCents = convert(fscCad);
  const customsBrokerageCents = convert(customsCad);
  const accessorialBreakdown = accessorialBreakdownCad.map((a) => ({
    ...a,
    amountCents: convert(a.amountCents),
  }));
  const accessorialsCents = accessorialBreakdown.reduce((sum, a) => sum + a.amountCents, 0);
  const subtotalCents = linehaulCents + fuelSurchargeCents + customsBrokerageCents + accessorialsCents;

  // Transit hours: 80 km/h avg highway speed; solo HOS adds 10h rest per 11h driving; team runs continuous
  const pureDriveHours = distanceKm / 80;
  const hosRestHours = input.requiresTeamDriver ? 0 : Math.floor(pureDriveHours / 11) * 10;
  const borderHours = isCrossBorder ? Math.max(0.5, borderDelayMinutes / 60) : 0;
  const estimatedTransitHours = Math.max(2, Math.ceil(pureDriveHours + hosRestHours + borderHours + 2));

  // EPA SmartWay Class-8 tractor-trailer factor: 161.8 g CO2e / short-ton-mile (+12% reefer auxiliary diesel)
  const shortTons = Math.max(1, input.weightLbs / 2000);
  const reeferEmissionMultiplier = input.equipmentType === 'reefer' ? 1.12 : 1.0;
  const co2Kg = Math.max(1, Math.round(distanceMiles * shortTons * 0.1618 * reeferEmissionMultiplier));

  const recommendedEquipmentLabel =
    input.equipmentType === 'reefer'
      ? '53ft Climate-Controlled Reefer (Thermo King S-600)'
      : input.equipmentType === 'flatbed'
        ? '53ft High-Tensile Open-Deck Flatbed'
        : '53ft High-Cube Enclosed Dry Van';

  return {
    distanceKm,
    distanceMiles,
    isCrossBorder,
    currency: input.currency,
    linehaulCents,
    fuelSurchargeCents,
    customsBrokerageCents,
    accessorialsCents,
    accessorialBreakdown,
    demandMultiplier,
    subtotalCents,
    totalCents: subtotalCents,
    estimatedTransitHours,
    co2Kg,
    recommendedEquipmentLabel,
  };
}

/** Great-circle Haversine distance in kilometers. */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
