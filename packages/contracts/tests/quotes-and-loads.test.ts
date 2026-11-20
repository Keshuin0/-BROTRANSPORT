import { describe, it, expect } from 'vitest';
import {
  canAccessRoute,
  calculateFreightRate,
  calculateDetentionCents,
  canTransitionLoadStatus,
  evaluateDocumentHitlGate,
  QuoteRequestSchema,
} from '../src/index.js';

describe('@bro/contracts — Auth, Quotes, Loads & Document HITL', () => {
  it('enforces strict dual-portal RBAC boundaries', () => {
    expect(canAccessRoute('visitor', '/ops/dispatch')).toBe(false);
    expect(canAccessRoute('carrier_driver', '/ops/dispatch')).toBe(false);
    expect(canAccessRoute('carrier_driver', '/portal/driver')).toBe(true);
    expect(canAccessRoute('carrier_driver', '/portal/shipper')).toBe(false);
    expect(canAccessRoute('shipper_user', '/portal/shipper')).toBe(true);
    expect(canAccessRoute('dispatcher', '/ops/dispatch')).toBe(true);
    expect(canAccessRoute('dispatcher', '/ops/admin')).toBe(false);
    expect(canAccessRoute('billing_clerk', '/ops/billing')).toBe(true);
    expect(canAccessRoute('super_admin', '/ops/admin')).toBe(true);
  });

  it('prices longer corridors and cross-border loads deterministically in integer cents', () => {
    const shortDomestic = calculateFreightRate(
      {
        equipmentType: 'dry_van',
        originCity: 'Charlottetown',
        originProvinceState: 'PE',
        originCountry: 'CA',
        originLat: 46.25,
        originLon: -63.14,
        destCity: 'Moncton',
        destProvinceState: 'NB',
        destCountry: 'CA',
        destLat: 46.09,
        destLon: -64.78,
        weightLbs: 18000,
        requiresTarp: false,
        requiresStrapping: false,
        requiresTeamDriver: false,
        isHazmat: false,
        isFoodFda: false,
        currency: 'CAD',
      },
      165,
    );

    const longCrossBorderReefer = calculateFreightRate(
      {
        equipmentType: 'reefer',
        originCity: 'Charlottetown',
        originProvinceState: 'PE',
        originCountry: 'CA',
        originLat: 46.25,
        originLon: -63.14,
        destCity: 'Boston',
        destProvinceState: 'MA',
        destCountry: 'US',
        destLat: 42.36,
        destLon: -71.06,
        weightLbs: 41000,
        tempSetpointC: -18,
        requiresTarp: false,
        requiresStrapping: false,
        requiresTeamDriver: false,
        isHazmat: false,
        isFoodFda: true,
        currency: 'CAD',
      },
      1050,
    );

    expect(Number.isInteger(shortDomestic.totalCents)).toBe(true);
    expect(shortDomestic.customsBrokerageCents).toBe(0);
    expect(longCrossBorderReefer.isCrossBorder).toBe(true);
    expect(longCrossBorderReefer.customsBrokerageCents).toBe(18500);
    expect(longCrossBorderReefer.totalCents).toBeGreaterThan(shortDomestic.totalCents * 3);
    expect(longCrossBorderReefer.accessorialBreakdown.some((a) => a.code === 'FDA_PRIOR_NOTICE')).toBe(true);
    expect(longCrossBorderReefer.accessorialBreakdown.some((a) => a.code === 'HEAVY_PAYLOAD')).toBe(true);
    expect(longCrossBorderReefer.co2Kg).toBeGreaterThan(shortDomestic.co2Kg);
  });

  it('uses Zod v4 issues array cleanly on invalid quote requests', () => {
    const res = QuoteRequestSchema.safeParse({ equipmentType: 'dry_van', weightLbs: 999999 });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(Array.isArray(res.error.issues)).toBe(true);
      expect(res.error.issues.length).toBeGreaterThan(0);
    }
  });

  it('enforces strict 11-state load transitions', () => {
    expect(canTransitionLoadStatus('QUOTED', 'BOOKED')).toBe(true);
    expect(canTransitionLoadStatus('QUOTED', 'PAID')).toBe(false);
    expect(canTransitionLoadStatus('AT_BORDER', 'CLEARED')).toBe(true);
    expect(canTransitionLoadStatus('DELIVERED', 'INVOICED')).toBe(true);
    expect(canTransitionLoadStatus('PAID', 'DISPATCHED')).toBe(false);
  });

  it('calculates detention billing in 15-minute increments after 2h free time', () => {
    const start = 1_700_000_000_000;
    const withinFree = calculateDetentionCents(start, start + 115 * 60_000);
    expect(withinFree.detentionCents).toBe(0);

    const overBy20Min = calculateDetentionCents(start, start + 140 * 60_000, 120, 8000);
    expect(overBy20Min.billableMinutes).toBe(30); // ceil(20/15)*15
    expect(overBy20Min.detentionCents).toBe(4000); // 0.5h * $80
  });

  it('escalates damaged PODs and low-confidence OCR to Human-in-the-Loop review', () => {
    const damagedPod = evaluateDocumentHitlGate({
      docType: 'POD',
      overallConfidence: 0.98,
      fieldConfidences: {},
      hasSignature: true,
      hasOsdDamageOrShortage: true,
    });
    expect(damagedPod.needsHumanReview).toBe(true);

    const cleanPod = evaluateDocumentHitlGate({
      docType: 'POD',
      overallConfidence: 0.96,
      fieldConfidences: {},
      hasSignature: true,
      hasOsdDamageOrShortage: false,
    });
    expect(cleanPod.needsHumanReview).toBe(false);
  });
});
