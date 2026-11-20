import { describe, it, expect } from 'vitest';
import {
  validateVin,
  validateCustomsManifest,
  calculateInvoiceTotals,
  calculateDriverSettlement,
  calculateIftaQuarter,
  computeWeibullSurvival,
  parseEdi204,
  generateEdi990,
  generateEdi214,
  generateEdi210,
  generateEdi997,
  canonicalizePayload,
} from '../src/index.js';

describe('@bro/contracts — Customs, Tax/IFTA, Weibull-Cox & EDI Engines', () => {
  it('validates ISO 3779 17-char VIN check digits accurately', () => {
    expect(validateVin('1HGCM82633A004352')).toBe(true); // valid check digit '3'
    expect(validateVin('1HGCM82693A004352')).toBe(false); // bad check digit '9'
    expect(validateVin('1FVACWDB2GHXXXXXX')).toBe(false); // placeholder X's fail
  });

  it('enforces ACE PAPS FDA 2-hr prior notice and CBSA CARM Release 2 IOR gate', () => {
    const now = Date.parse('2026-11-20T12:00:00Z');
    const validSouthbound = validateCustomsManifest(
      {
        manifestType: 'ACE_PAPS',
        scacOrCarrierCode: 'BROP',
        controlNumber: 'BROP8843921',
        tripNumber: 'BROP20261120A',
        portCode: '0115',
        etaUtc: '2026-11-20T15:00:00Z', // 180 min lead (> 120 min FDA requirement)
        conveyance: { vin: '1HGCM82633A004352', plate: 'PE9948', jurisdiction: 'PE' },
        crew: [{ fastCardNumber: '980012345', firstName: 'Liam', lastName: 'Gallant', dateOfBirth: '1984-05-10' }],
        carmIorAccountVerified: false,
        fdaPriorNoticeNumber: 'FDA-PN-99887766',
        shipments: [
          {
            commodity: 'Fresh PEI Potatoes',
            hsCode: '070190',
            countryOfOrigin: 'CA',
            cusmaCertOnFile: true,
            invoiceValueCents: 4200000,
            currency: 'USD',
            weightKg: 21500,
            quantity: 24,
            packageType: 'Pallet',
            isFoodFda: true,
            shipperName: 'Cavendish Valley Produce Co.',
            shipperAddress: '100 Harvest Rd, Summerside, PE',
            consigneeName: 'New England Fresh Market Hub',
            consigneeAddress: '45 Terminal Way, Boston, MA',
          },
        ],
      },
      now,
    );
    expect(validSouthbound.compliant).toBe(true);
    expect(validSouthbound.errors).toHaveLength(0);

    const badNorthboundNoCarm = validateCustomsManifest(
      {
        manifestType: 'ACI_PARS',
        scacOrCarrierCode: 'BROP',
        controlNumber: 'WRONG9999', // prefix mismatch
        tripNumber: 'BROP20261120B',
        portCode: '0712',
        etaUtc: '2026-11-20T12:30:00Z', // only 30 min (< 60 min)
        conveyance: { vin: '1HGCM82693A004352', plate: 'PE9948', jurisdiction: 'PE' }, // bad VIN
        crew: [{ fastCardNumber: '12345', firstName: 'Liam', lastName: 'Gallant', dateOfBirth: '1984-05-10' }],
        carmIorAccountVerified: false,
        shipments: [
          {
            commodity: 'Structural Steel',
            hsCode: '721632',
            countryOfOrigin: 'US',
            cusmaCertOnFile: false,
            invoiceValueCents: 6500000,
            currency: 'CAD',
            weightKg: 39000, // overweight without permit
            quantity: 12,
            packageType: 'Bundle',
            isFoodFda: false,
            shipperName: 'Northeast Steel',
            shipperAddress: '12 Foundry St, Albany, NY',
            consigneeName: 'Fundy Structural Steel',
            consigneeAddress: '88 Industrial Pkwy, Moncton, NB',
          },
        ],
      },
      now,
    );
    expect(badNorthboundNoCarm.compliant).toBe(false);
    expect(badNorthboundNoCarm.errors.length).toBeGreaterThanOrEqual(6);
    expect(badNorthboundNoCarm.warnings.length).toBeGreaterThan(0);
  });

  it('zero-rates cross-border freight and applies 15% HST on domestic PEI loads', () => {
    const crossBorder = calculateInvoiceTotals({
      lineItems: [{ code: 'LH', description: 'Linehaul', quantity: 1, unitPriceCents: 300000, amountCents: 300000 }],
      direction: 'ca_to_us',
    });
    expect(crossBorder.taxCents).toBe(0);
    expect(crossBorder.totalCents).toBe(300000);

    const domesticPei = calculateInvoiceTotals({
      lineItems: [{ code: 'LH', description: 'Linehaul', quantity: 1, unitPriceCents: 100000, amountCents: 100000 }],
      direction: 'domestic_ca',
      destinationProvince: 'PE',
    });
    expect(domesticPei.taxCents).toBe(15000);
    expect(domesticPei.totalCents).toBe(115000);
  });

  it('calculates driver settlements and quarterly IFTA reconciliation accurately', () => {
    const cpm = calculateDriverSettlement({
      payModel: 'cpm',
      rateValue: 70, // $0.70/mi
      loadedMiles: 1000,
      loadGrossCents: 350000,
      detentionPayCents: 5000,
      deductionsCents: 10000,
    });
    expect(cpm.grossPayCents).toBe(75000);
    expect(cpm.netPayCents).toBe(65000);

    const oo = calculateDriverSettlement({
      payModel: 'percent_gross',
      rateValue: 8200, // 82%
      loadedMiles: 1000,
      loadGrossCents: 400000,
      deductionsCents: 28000,
    });
    expect(oo.grossPayCents).toBe(328000);
    expect(oo.netPayCents).toBe(300000);

    const ifta = calculateIftaQuarter('2026-Q4', [
      { jurisdictionCode: 'NB', distanceKm: 482.8, fuelLiters: 250 },
      { jurisdictionCode: 'ME', distanceKm: 482.8, fuelLiters: 100 },
    ]);
    expect(ifta.totalMiles).toBeCloseTo(600, 0);
    expect(ifta.jurisdictions).toHaveLength(2);
    expect(ifta.fleetMpg).toBeGreaterThan(5);
  });

  it('computes strictly bounded [0, 100%] Weibull-Cox survival and RUL', () => {
    const healthy = computeWeibullSurvival({
      operatingHours: 1200,
      tempDeviationC: 0.2,
      tpmsDeviationPsi: 1,
      vibrationHz: 12.2,
    });
    expect(healthy.survivalProbability).toBeGreaterThan(0.9);
    expect(healthy.failureRiskPct).toBeLessThan(10);
    expect(healthy.riskTier).toBe('NOMINAL');

    const extreme = computeWeibullSurvival({
      operatingHours: 8000,
      tempDeviationC: 25,
      tpmsDeviationPsi: 35,
      vibrationHz: 45,
    });
    expect(extreme.survivalProbability).toBeGreaterThanOrEqual(0);
    expect(extreme.failureRiskPct).toBeLessThanOrEqual(100);
    expect(extreme.riskTier).toBe('CRITICAL');
  });

  it('parses EDI 204 tenders and generates compliant 990/214/210/997 transactions', () => {
    const sample204 = [
      'ISA*00*          *00*          *02*SHIPPER1       *02*BROP           *261120*1200*U*00401*000000042*0*P*:~',
      'GS*SM*SHIPPER1*BROP*20261120*1200*42*X*004010~',
      'ST*204*0042~',
      'B2**BROP**SHIP-9948**PP~',
      'S5*1*CL~',
      'N1*SF*Cavendish Produce~',
      'N4*Summerside*PE~',
      'S5*2*UL~',
      'N1*CN*Boston Fresh Hub~',
      'N4*Boston*MA~',
      'L3*38500*G***3450.00~',
      'SE*10*0042~',
      'GE*1*42~',
      'IEA*1*000000042~',
    ].join('\n');

    const parsed = parseEdi204(sample204);
    expect(parsed.shipmentId).toBe('SHIP-9948');
    expect(parsed.rateCents).toBe(345000);
    expect(parsed.stops).toHaveLength(2);
    expect(parsed.stops[0].city).toBe('Summerside');

    const edi990 = generateEdi990({ scac: 'BROP', shipmentId: 'SHIP-9948', action: 'A', receiverId: 'SHIPPER1', controlNumber: '43' });
    expect(edi990).toContain('ST*990*0043~');
    expect(edi990).toContain('B1*BROP*SHIP-9948*');

    const edi214 = generateEdi214({ scac: 'BROP', shipmentId: 'SHIP-9948', statusCode: 'D1', city: 'Boston', stateProv: 'MA', receiverId: 'SHIPPER1', controlNumber: '44' });
    expect(edi214).toContain('AT7*D1*NS');

    const edi210 = generateEdi210({ scac: 'BROP', invoiceNumber: 'INV-2026-001', shipmentId: 'SHIP-9948', totalCents: 345000, currency: 'CAD', receiverId: 'SHIPPER1', controlNumber: '45' });
    expect(edi210).toContain('ST*210*0045~');
    expect(edi210).toContain('345000');

    const edi997 = generateEdi997({ scac: 'BROP', receiverId: 'SHIPPER1', ackedSet: '204', ackedControlNumber: '0042', accepted: true, controlNumber: '46' });
    expect(edi997).toContain('AK5*A~');

    expect(canonicalizePayload({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  });
});
