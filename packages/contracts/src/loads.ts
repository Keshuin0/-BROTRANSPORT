import { z } from 'zod';
import { CurrencySchema, EquipmentTypeSchema } from './quotes.js';

export const LoadStatusSchema = z.enum([
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
]);

export type LoadStatus = z.infer<typeof LoadStatusSchema>;

export const LoadDirectionSchema = z.enum([
  'domestic_ca',
  'domestic_us',
  'ca_to_us',
  'us_to_ca',
]);

export type LoadDirection = z.infer<typeof LoadDirectionSchema>;

export const StopTypeSchema = z.enum(['pickup', 'border_crossing', 'delivery']);
export type StopType = z.infer<typeof StopTypeSchema>;

export const ALLOWED_STATUS_TRANSITIONS: Record<LoadStatus, readonly LoadStatus[]> = {
  QUOTED: ['BOOKED'],
  BOOKED: ['DISPATCHED'],
  DISPATCHED: ['AT_PICKUP', 'IN_TRANSIT'],
  AT_PICKUP: ['IN_TRANSIT'],
  IN_TRANSIT: ['AT_BORDER', 'AT_DELIVERY'],
  AT_BORDER: ['CLEARED'],
  CLEARED: ['AT_DELIVERY', 'IN_TRANSIT'],
  AT_DELIVERY: ['DELIVERED'],
  DELIVERED: ['INVOICED'],
  INVOICED: ['PAID'],
  PAID: [],
};

export function canTransitionLoadStatus(from: LoadStatus, to: LoadStatus): boolean {
  if (from === to) return true;
  return ALLOWED_STATUS_TRANSITIONS[from].includes(to);
}

export const CreateLoadSchema = z.object({
  shipperOrgId: z.string().min(1),
  equipmentType: EquipmentTypeSchema,
  direction: LoadDirectionSchema,
  commodity: z.string().trim().min(2).max(160),
  weightLbs: z.number().int().min(1).max(45000),
  rateCustomerCents: z.number().int().min(1000),
  rateCarrierCents: z.number().int().min(0).default(0),
  currency: CurrencySchema.default('CAD'),
  isFoodFda: z.boolean().default(false),
  tempSetpointC: z.number().min(-30).max(25).optional(),
  stops: z
    .array(
      z.object({
        seq: z.number().int().min(1),
        stopType: StopTypeSchema,
        facilityName: z.string().trim().min(2),
        address: z.string().trim().min(4),
        lat: z.number().min(14).max(72),
        lon: z.number().min(-170).max(-50),
        apptStart: z.number().int(),
        apptEnd: z.number().int(),
      }),
    )
    .min(2),
});

export type CreateLoadInput = z.infer<typeof CreateLoadSchema>;

export const StopCheckinSchema = z.object({
  event: z.enum(['arrived', 'departed']),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  timestampMs: z.number().int().optional(),
  notes: z.string().max(400).optional(),
});

export interface DetentionCalculation {
  dwellMinutes: number;
  billableMinutes: number;
  detentionCents: number;
}

/**
 * Deterministic detention billing engine.
 * Free time defaults to 120 minutes (2 hours); billed in 15-minute increments after free time.
 */
export function calculateDetentionCents(
  arrivedAtMs: number,
  departedAtMs: number,
  freeMinutes = 120,
  rateCentsPerHour = 8500,
): DetentionCalculation {
  if (departedAtMs <= arrivedAtMs) {
    return { dwellMinutes: 0, billableMinutes: 0, detentionCents: 0 };
  }
  const dwellMinutes = Math.floor((departedAtMs - arrivedAtMs) / 60000);
  const rawBillable = Math.max(0, dwellMinutes - freeMinutes);
  if (rawBillable === 0) {
    return { dwellMinutes, billableMinutes: 0, detentionCents: 0 };
  }
  const billedQuarters = Math.ceil(rawBillable / 15);
  const billableMinutes = billedQuarters * 15;
  const detentionCents = Math.round((billedQuarters * rateCentsPerHour) / 4);
  return { dwellMinutes, billableMinutes, detentionCents };
}
