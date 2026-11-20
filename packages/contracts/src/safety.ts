import { z } from 'zod';
import { EquipmentTypeSchema } from './quotes.js';

export const CarrierApplicationSchema = z.object({
  driverName: z.string().trim().min(2, { error: 'Driver or carrier legal name is required.' }),
  carrierCompanyName: z.string().trim().min(2).optional(),
  usdotNumber: z.string().trim().regex(/^\d{4,8}$/, { error: 'USDOT number must be 4 to 8 digits.' }).optional(),
  mcNumber: z.string().trim().max(12).optional(),
  driverEmail: z.email({ error: 'Valid email is required.' }),
  driverPhone: z.string().trim().min(10, { error: 'Valid 10-digit contact number is required.' }),
  equipmentType: EquipmentTypeSchema,
  preferredLanes: z.string().trim().min(3, { error: 'Specify your primary commercial corridors.' }),
  hasClass1OrAz: z.boolean().refine((v) => v === true, { error: 'Valid Class 1 or AZ commercial license is mandatory.' }),
  hasCleanAbstract: z.boolean().refine((v) => v === true, { error: 'Clean 3-year commercial driver abstract is mandatory.' }),
  hasFastCard: z.boolean().default(false),
  dotSafetyCertified: z.boolean().default(true),
  turnstileToken: z.string().optional(),
  offlinePowToken: z.string().optional(),
});

export type CarrierApplicationInput = z.infer<typeof CarrierApplicationSchema>;

export const DvirPointSchema = z.object({
  key: z.enum([
    'service_brakes',
    'parking_brake',
    'steering',
    'lighting_reflectors',
    'tires_tpms',
    'horn',
    'mirrors',
    'coupling_fifth_wheel',
    'suspension_axles',
    'exhaust_system',
    'reefer_unit',
    'cargo_securement',
  ]),
  status: z.enum(['pass', 'defect']),
  notes: z.string().max(300).optional(),
});

export const DvirSubmitSchema = z.object({
  tractorId: z.string().min(1),
  trailerId: z.string().optional(),
  inspectionType: z.enum(['pre_trip', 'post_trip']),
  odometerKm: z.number().int().min(0).max(5_000_000),
  checklist: z.array(DvirPointSchema).min(6),
  safeToOperate: z.boolean(),
  driverSignatureName: z.string().trim().min(2),
});

export type DvirSubmitInput = z.infer<typeof DvirSubmitSchema>;

export interface WeibullSurvivalInput {
  operatingHours: number;
  shapeK?: number;
  scaleEtaHours?: number;
  tempDeviationC: number;
  tpmsDeviationPsi: number;
  vibrationHz: number;
}

export interface WeibullSurvivalResult {
  instantaneousHazard: number;
  survivalProbability: number; // Strictly [0, 1]
  failureRiskPct: number; // Strictly [0, 100]
  remainingUsefulLifeHours: number;
  maintenanceUrgent: boolean;
  riskTier: 'NOMINAL' | 'ELEVATED' | 'CRITICAL';
}

/**
 * Authentic Weibull-Cox Proportional Hazards Survival Engine:
 *   lambda(t | z) = (k / eta) * (t / eta)^(k - 1) * exp(beta^T * z)
 *   S(t | z)      = exp( - (t / eta)^k * exp(beta^T * z) )
 * Guaranteed bounded survival probability in [0, 1] and failureRiskPct in [0, 100].
 */
export function computeWeibullSurvival(input: WeibullSurvivalInput): WeibullSurvivalResult {
  const t = Math.max(1, input.operatingHours);
  const k = input.shapeK ?? 2.1;
  const eta = input.scaleEtaHours ?? 8500;

  // Sensor covariate deviations above nominal baseline (12 Hz nominal chassis vibration)
  const zTemp = Math.max(0, Math.abs(input.tempDeviationC));
  const zTpms = Math.max(0, Math.abs(input.tpmsDeviationPsi));
  const zVib = Math.max(0, input.vibrationHz - 12);

  // Calibrated proportional hazards coefficients (bounded exponent to prevent overflow)
  const betaZ = Math.min(6.0, 0.28 * zTemp + 0.14 * zTpms + 0.11 * zVib);
  const covariateMultiplier = Math.exp(betaZ);

  const baselineHazard = (k / eta) * Math.pow(t / eta, k - 1);
  const instantaneousHazard = Number((baselineHazard * covariateMultiplier).toFixed(6));

  const cumulativeHazard = Math.pow(t / eta, k) * covariateMultiplier;
  const survivalProbability = Number(Math.min(1, Math.max(0, Math.exp(-cumulativeHazard))).toFixed(4));
  const failureRiskPct = Number(((1 - survivalProbability) * 100).toFixed(1));

  // Median remaining useful life: solve S(t_50 | z) = 0.50 => t_50 = eta * (ln(2) / exp(betaZ))^(1/k)
  const medianLifeHours = eta * Math.pow(Math.LN2 / covariateMultiplier, 1 / k);
  const remainingUsefulLifeHours = Math.max(0, Math.round(medianLifeHours - t));

  const riskTier: WeibullSurvivalResult['riskTier'] =
    failureRiskPct >= 65 || remainingUsefulLifeHours < 72
      ? 'CRITICAL'
      : failureRiskPct >= 30 || remainingUsefulLifeHours < 250
        ? 'ELEVATED'
        : 'NOMINAL';

  return {
    instantaneousHazard,
    survivalProbability,
    failureRiskPct,
    remainingUsefulLifeHours,
    maintenanceUrgent: riskTier === 'CRITICAL',
    riskTier,
  };
}
