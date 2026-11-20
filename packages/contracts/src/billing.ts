import { z } from 'zod';
import { CurrencySchema } from './quotes.js';
import { LoadDirectionSchema, type LoadDirection } from './loads.js';

export const InvoiceLineItemSchema = z.object({
  code: z.string().min(2),
  description: z.string().min(2),
  quantity: z.number().positive().default(1),
  unitPriceCents: z.number().int(),
  amountCents: z.number().int(),
});

export type InvoiceLineItem = z.infer<typeof InvoiceLineItemSchema>;

export const InvoiceStatusSchema = z.enum([
  'draft',
  'pending_approval',
  'sent',
  'partially_paid',
  'paid',
  'disputed',
  'factored',
]);

export type InvoiceStatus = z.infer<typeof InvoiceStatusSchema>;

const DOMESTIC_CANADA_TAX_BPS: Record<string, { label: string; bps: number }> = {
  PE: { label: 'PEI HST (15%)', bps: 1500 },
  NB: { label: 'NB HST (15%)', bps: 1500 },
  NS: { label: 'NS HST (15%)', bps: 1500 },
  NL: { label: 'NL HST (15%)', bps: 1500 },
  ON: { label: 'ON HST (13%)', bps: 1300 },
  QC: { label: 'GST + QST (14.975%)', bps: 1498 },
  AB: { label: 'GST (5%)', bps: 500 },
  BC: { label: 'GST (5%)', bps: 500 },
  MB: { label: 'GST (5%)', bps: 500 },
  SK: { label: 'GST (5%)', bps: 500 },
};

export interface InvoiceTotals {
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  taxLabel: string;
  taxCitation: string;
}

/**
 * Deterministic North American freight tax & invoice calculator (integer cents).
 * International CA<->US freight is 0% zero-rated under Canada Excise Tax Act Schedule VI Part VII.
 */
export function calculateInvoiceTotals(params: {
  lineItems: InvoiceLineItem[];
  direction: LoadDirection;
  destinationProvince?: string;
}): InvoiceTotals {
  const subtotalCents = params.lineItems.reduce((sum, item) => sum + item.amountCents, 0);

  if (params.direction === 'ca_to_us' || params.direction === 'us_to_ca') {
    return {
      subtotalCents,
      taxCents: 0,
      totalCents: subtotalCents,
      taxLabel: 'Zero-Rated International Freight (0%)',
      taxCitation: 'Canada ETA Sch. VI, Part VII, s. 7',
    };
  }

  if (params.direction === 'domestic_us') {
    return {
      subtotalCents,
      taxCents: 0,
      totalCents: subtotalCents,
      taxLabel: 'U.S. Interstate Freight (Exempt 0%)',
      taxCitation: '49 U.S.C. § 14505',
    };
  }

  const prov = (params.destinationProvince || 'PE').toUpperCase();
  const taxRule = DOMESTIC_CANADA_TAX_BPS[prov] ?? { label: 'Federal GST (5%)', bps: 500 };
  const taxCents = Math.round((subtotalCents * taxRule.bps) / 10000);
  return {
    subtotalCents,
    taxCents,
    totalCents: subtotalCents + taxCents,
    taxLabel: taxRule.label,
    taxCitation: 'Canada Excise Tax Act',
  };
}

export const DriverPayModelSchema = z.enum(['cpm', 'percent_gross']);
export type DriverPayModel = z.infer<typeof DriverPayModelSchema>;

export const SettlementDeductionSchema = z.object({
  code: z.string().min(2),
  label: z.string().min(2),
  amountCents: z.number().int().min(0),
});

export interface DriverSettlementCalculation {
  grossPayCents: number;
  reimbursementsCents: number;
  deductionsCents: number;
  netPayCents: number;
}

/**
 * Pure integer-cent Driver Settlement calculator supporting Company Driver (CPM) & Owner-Operator (% Gross).
 * - For `cpm`: `rateValue` is cents per mile (e.g., `68` = $0.68/mi).
 * - For `percent_gross`: `rateValue` is basis points (e.g., `8200` = 82.00% of gross).
 */
export function calculateDriverSettlement(params: {
  payModel: DriverPayModel;
  rateValue: number;
  loadedMiles: number;
  loadGrossCents: number;
  detentionPayCents?: number;
  reimbursementsCents?: number;
  deductionsCents?: number;
}): DriverSettlementCalculation {
  const linehaulPay =
    params.payModel === 'cpm'
      ? Math.round(params.loadedMiles * params.rateValue)
      : Math.round((params.loadGrossCents * params.rateValue) / 10000);

  const grossPayCents = linehaulPay + (params.detentionPayCents ?? 0);
  const reimbursementsCents = params.reimbursementsCents ?? 0;
  const deductionsCents = params.deductionsCents ?? 0;
  const netPayCents = grossPayCents + reimbursementsCents - deductionsCents;

  return {
    grossPayCents,
    reimbursementsCents,
    deductionsCents,
    netPayCents,
  };
}

export const IftaLogInputSchema = z.object({
  loadId: z.string().optional(),
  tractorId: z.string().min(1),
  quarter: z.string().regex(/^\d{4}-Q[1-4]$/, { error: 'Quarter format must be YYYY-Q1..Q4.' }),
  jurisdictionCode: z.string().trim().toUpperCase().length(2),
  distanceKm: z.number().nonnegative(),
  fuelLiters: z.number().nonnegative().default(0),
  fuelCostCents: z.number().int().nonnegative().default(0),
  receiptDocId: z.string().optional(),
});

export type IftaLogInput = z.infer<typeof IftaLogInputSchema>;

/** Approximate diesel IFTA tax rates in USD cents per US gallon (2026 baseline schedule). */
export const IFTA_DIESEL_RATE_CENTS_PER_GAL: Record<string, number> = {
  PE: 41,
  NB: 46,
  NS: 43,
  QC: 55,
  ON: 39,
  MB: 38,
  SK: 40,
  AB: 35,
  BC: 44,
  ME: 31,
  NH: 22,
  VT: 31,
  MA: 24,
  NY: 40,
  PA: 74,
  OH: 47,
  MI: 30,
  IL: 78,
  IN: 59,
  TX: 20,
  GA: 36,
  FL: 39,
  WA: 49,
  CA: 102,
};

export interface IftaJurisdictionSummary {
  jurisdictionCode: string;
  miles: number;
  taxableGallons: number;
  taxPaidGallons: number;
  netTaxableGallons: number;
  taxRateCentsPerGal: number;
  netTaxDueCents: number;
}

export interface IftaQuarterReport {
  quarter: string;
  totalMiles: number;
  totalGallons: number;
  fleetMpg: number;
  jurisdictions: IftaJurisdictionSummary[];
  totalNetTaxDueCents: number;
}

const KM_PER_MILE = 1.60934;
const LITERS_PER_US_GAL = 3.78541;

export function calculateIftaQuarter(
  quarter: string,
  logs: Array<{ jurisdictionCode: string; distanceKm: number; fuelLiters: number }>,
): IftaQuarterReport {
  const byJur = new Map<string, { km: number; liters: number }>();

  for (const row of logs) {
    const code = row.jurisdictionCode.toUpperCase();
    const cur = byJur.get(code) ?? { km: 0, liters: 0 };
    cur.km += row.distanceKm;
    cur.liters += row.fuelLiters;
    byJur.set(code, cur);
  }

  let totalKm = 0;
  let totalLiters = 0;
  byJur.forEach((v) => {
    totalKm += v.km;
    totalLiters += v.liters;
  });

  const totalMiles = Number((totalKm / KM_PER_MILE).toFixed(2));
  const totalGallons = Number((totalLiters / LITERS_PER_US_GAL).toFixed(2));
  // Guard divide-by-zero with standard Class-8 6.5 MPG fallback when no fuel receipts logged yet
  const fleetMpg = totalGallons > 0 ? Number((totalMiles / totalGallons).toFixed(2)) : 6.5;

  const jurisdictions: IftaJurisdictionSummary[] = [];
  let totalNetTaxDueCents = 0;

  for (const [code, vals] of [...byJur.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const miles = Number((vals.km / KM_PER_MILE).toFixed(2));
    const taxableGallons = Number((miles / fleetMpg).toFixed(2));
    const taxPaidGallons = Number((vals.liters / LITERS_PER_US_GAL).toFixed(2));
    const netTaxableGallons = Number((taxableGallons - taxPaidGallons).toFixed(2));
    const rate = IFTA_DIESEL_RATE_CENTS_PER_GAL[code] ?? 35;
    const netTaxDueCents = Math.round(netTaxableGallons * rate);
    totalNetTaxDueCents += netTaxDueCents;

    jurisdictions.push({
      jurisdictionCode: code,
      miles,
      taxableGallons,
      taxPaidGallons,
      netTaxableGallons,
      taxRateCentsPerGal: rate,
      netTaxDueCents,
    });
  }

  return {
    quarter,
    totalMiles,
    totalGallons,
    fleetMpg,
    jurisdictions,
    totalNetTaxDueCents,
  };
}

export const CreateInvoiceSchema = z.object({
  loadId: z.string().min(1),
  shipperOrgId: z.string().min(1),
  currency: CurrencySchema.default('CAD'),
  direction: LoadDirectionSchema,
  destinationProvince: z.string().max(2).optional(),
  lineItems: z.array(InvoiceLineItemSchema).min(1),
  dueDays: z.number().int().min(0).max(90).default(30),
});
