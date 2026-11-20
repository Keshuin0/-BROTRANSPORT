import { z } from 'zod';
import type { CloudflareEnv } from '../../src/env';

export const FMCSA_QCMOBILE_BASE_URL = 'https://mobile.fmcsa.dot.gov/qc/services/carriers';
export const FMCSA_CACHE_TTL_SECONDS = 86_400; // 24 hours
export const MIN_BIPD_INSURANCE_CENTS = 75_000_000; // $750,000.00 USD (49 CFR § 387.9)
const FMCSA_TIMEOUT_MS = 6000;

const DotNumberSchema = z
  .string()
  .trim()
  .regex(/^\d{4,8}$/, { error: 'USDOT number must be 4 to 8 numeric digits.' });

export type AuthorityStatus = 'A' | 'I' | 'N';

export interface FmcsaCarrierRecord {
  dotNumber: string;
  legalName: string;
  dbaName: string | null;
  allowedToOperate: boolean;
  statusCode: string;
  oosDate: string | null;
  commonAuthorityStatus: AuthorityStatus;
  contractAuthorityStatus: AuthorityStatus;
  brokerAuthorityStatus: AuthorityStatus;
  /** Public liability (BIPD) insurance on file in integer USD cents. */
  bipdInsuranceOnFileCents: number;
  /** Required BIPD insurance in integer USD cents. */
  bipdInsuranceRequiredCents: number;
  /** Cargo insurance on file in integer USD cents. */
  cargoInsuranceOnFileCents: number;
  totalPowerUnits: number;
  totalDrivers: number;
  safetyRating: string | null;
  phyCity: string | null;
  phyState: string | null;
  phyCountry: string | null;
  fetchedAt: string;
}

export type CarrierFraudFlagCode =
  | 'NOT_AUTHORIZED'
  | 'INSURANCE_DEFICIENT'
  | 'DOUBLE_BROKERING_CAPACITY_ANOMALY'
  | 'BROKER_ONLY_AUTHORITY';

export interface CarrierFraudFinding {
  code: CarrierFraudFlagCode;
  severity: 'critical' | 'high';
  detail: string;
}

export interface CarrierFraudAssessment {
  approved: boolean;
  riskLevel: 'LOW' | 'ELEVATED' | 'CRITICAL';
  riskScore: number;
  flags: CarrierFraudFlagCode[];
  findings: CarrierFraudFinding[];
  activeAssignedLoadsCount: number;
  totalPowerUnits: number;
  utilizationRatio: number | null;
}

export type FmcsaVerifyReason =
  | 'VERIFIED'
  | 'DEV_FIXTURE'
  | 'INVALID_DOT_NUMBER'
  | 'FMCSA_KEY_UNCONFIGURED'
  | 'CARRIER_NOT_FOUND'
  | 'FMCSA_UPSTREAM_ERROR';

export interface FmcsaVerificationResult {
  verified: boolean;
  reason: FmcsaVerifyReason;
  dotNumber: string;
  record: FmcsaCarrierRecord | null;
  fraudAssessment: CarrierFraudAssessment | null;
  cached: boolean;
  source: 'fmcsa_qcmobile' | 'dev_fixture' | 'unconfigured' | 'error';
  error?: string;
}

function normalizeAuthorityStatus(raw: unknown): AuthorityStatus {
  const val = String(raw ?? '').trim().toUpperCase();
  if (val === 'A') return 'A';
  if (val === 'I') return 'I';
  return 'N';
}

/**
 * Converts FMCSA QCMobile insurance values into integer USD cents.
 * QCMobile reports BIPD/Cargo coverage in thousands of USD (e.g. "750" = $750,000, "1000" = $1,000,000).
 * Values > 50,000 are treated as whole USD dollars for defensive normalization.
 */
function parseFmcsaInsuranceCents(raw: unknown): number {
  if (raw == null || raw === '') return 0;
  const cleaned = String(raw).replace(/[$,\s]/g, '');
  if (!/^\d+(?:\.\d+)?$/.test(cleaned)) return 0;
  const numeric = Number(cleaned);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  if (numeric <= 50_000) {
    return Math.round(numeric * 1000 * 100);
  }
  return Math.round(numeric * 100);
}

function parseNonNegativeInt(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.trunc(n);
}

function normalizeOptionalString(raw: unknown): string | null {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Pure parser normalizing a raw FMCSA QCMobile JSON payload into FmcsaCarrierRecord.
 */
export function parseFmcsaQcmobileResponse(
  rawJson: unknown,
  fallbackDotNumber: string,
): FmcsaCarrierRecord | null {
  if (!rawJson || typeof rawJson !== 'object') return null;
  const content = (rawJson as Record<string, unknown>).content;
  if (!content || typeof content !== 'object') return null;

  const carrier = (content as Record<string, unknown>).carrier;
  if (!carrier || typeof carrier !== 'object') return null;

  const c = carrier as Record<string, unknown>;
  const dotNumber = String(c.dotNumber ?? fallbackDotNumber).trim();
  const legalName = normalizeOptionalString(c.legalName);
  if (!dotNumber || !legalName) return null;

  const allowedStr = String(c.allowedToOperate ?? '').trim().toUpperCase();
  const statusCode = String(c.statusCode ?? '').trim().toUpperCase() || 'U';
  const oosDate = normalizeOptionalString(c.oosDate);

  return {
    dotNumber,
    legalName,
    dbaName: normalizeOptionalString(c.dbaName),
    allowedToOperate: allowedStr === 'Y' && oosDate === null,
    statusCode,
    oosDate,
    commonAuthorityStatus: normalizeAuthorityStatus(c.commonAuthorityStatus),
    contractAuthorityStatus: normalizeAuthorityStatus(c.contractAuthorityStatus),
    brokerAuthorityStatus: normalizeAuthorityStatus(c.brokerAuthorityStatus),
    bipdInsuranceOnFileCents: parseFmcsaInsuranceCents(c.bipdInsuranceOnFile),
    bipdInsuranceRequiredCents: parseFmcsaInsuranceCents(c.bipdRequiredAmount || 750),
    cargoInsuranceOnFileCents: parseFmcsaInsuranceCents(c.cargoInsuranceOnFile),
    totalPowerUnits: parseNonNegativeInt(c.totalPowerUnits),
    totalDrivers: parseNonNegativeInt(c.totalDrivers),
    safetyRating: normalizeOptionalString(c.safetyRating),
    phyCity: normalizeOptionalString(c.phyCity),
    phyState: normalizeOptionalString(c.phyState),
    phyCountry: normalizeOptionalString(c.phyCountry),
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Deterministic carrier compliance & double-brokering fraud risk evaluator.
 * Evaluates FMCSA authority, $750,000 federal BIPD minimum, broker-only status,
 * and active load capacity ratio against registered power units.
 */
export function evaluateCarrierFraudRisk(
  record: FmcsaCarrierRecord,
  activeAssignedLoadsCount = 0,
): CarrierFraudAssessment {
  const safeActiveLoads = Math.max(0, Math.trunc(activeAssignedLoadsCount));
  const findings: CarrierFraudFinding[] = [];
  let riskScore = 0;

  const hasActiveMotorAuthority =
    record.commonAuthorityStatus === 'A' || record.contractAuthorityStatus === 'A';
  const isBrokerOnly = record.brokerAuthorityStatus === 'A' && !hasActiveMotorAuthority;

  // 1. Operating authority / Out-of-Service gate
  if (!record.allowedToOperate || record.oosDate !== null || (!hasActiveMotorAuthority && !isBrokerOnly)) {
    const reasons: string[] = [];
    if (!record.allowedToOperate) reasons.push('FMCSA allowedToOperate is not active');
    if (record.oosDate) reasons.push(`Out-of-Service order dated ${record.oosDate}`);
    if (!hasActiveMotorAuthority) reasons.push('no active Common or Contract motor carrier authority');

    findings.push({
      code: 'NOT_AUTHORIZED',
      severity: 'critical',
      detail: `Carrier DOT #${record.dotNumber} is not authorized to haul commercial freight (${reasons.join('; ')}).`,
    });
    riskScore += 45;
  }

  // 2. Broker-only authority detection (common vector for unauthorized re-brokering)
  if (isBrokerOnly) {
    findings.push({
      code: 'BROKER_ONLY_AUTHORITY',
      severity: 'critical',
      detail: `Carrier DOT #${record.dotNumber} holds Broker authority only without active Common or Contract motor carrier authority.`,
    });
    riskScore += 40;
  }

  // 3. Federal 49 CFR § 387.9 BIPD insurance floor ($750,000 USD = 75,000,000 cents)
  if (record.bipdInsuranceOnFileCents < MIN_BIPD_INSURANCE_CENTS) {
    const onFileUsd = Math.floor(record.bipdInsuranceOnFileCents / 100).toLocaleString('en-US');
    findings.push({
      code: 'INSURANCE_DEFICIENT',
      severity: 'critical',
      detail: `BIPD public liability insurance on file ($${onFileUsd} USD) is below the $750,000 USD federal commercial minimum.`,
    });
    riskScore += 35;
  }

  // 4. Double-brokering fleet capacity anomaly (0 trucks OR active loads >= totalPowerUnits)
  if (record.totalPowerUnits <= 0 || safeActiveLoads >= record.totalPowerUnits) {
    const detail =
      record.totalPowerUnits <= 0
        ? `Carrier DOT #${record.dotNumber} reports 0 registered power units on FMCSA census — high double-brokering risk.`
        : `Active assigned loads (${safeActiveLoads}) meet or exceed FMCSA registered fleet size (${record.totalPowerUnits} power units).`;

    findings.push({
      code: 'DOUBLE_BROKERING_CAPACITY_ANOMALY',
      severity: 'high',
      detail,
    });
    riskScore += 35;
  }

  const boundedScore = Math.min(100, riskScore);
  const flags = findings.map((f) => f.code);
  const riskLevel: CarrierFraudAssessment['riskLevel'] =
    boundedScore >= 60 ? 'CRITICAL' : boundedScore >= 25 ? 'ELEVATED' : 'LOW';

  return {
    approved: findings.length === 0,
    riskLevel,
    riskScore: boundedScore,
    flags,
    findings,
    activeAssignedLoadsCount: safeActiveLoads,
    totalPowerUnits: record.totalPowerUnits,
    utilizationRatio:
      record.totalPowerUnits > 0
        ? Number((safeActiveLoads / record.totalPowerUnits).toFixed(3))
        : null,
  };
}

function getDevelopmentFixture(dotNumber: string): FmcsaCarrierRecord | null {
  const nowIso = new Date().toISOString();

  if (dotNumber === '123456') {
    return {
      dotNumber: '123456',
      legalName: 'MARITIME CORRIDOR CARRIERS LTD',
      dbaName: 'MARITIME CORRIDOR',
      allowedToOperate: true,
      statusCode: 'A',
      oosDate: null,
      commonAuthorityStatus: 'A',
      contractAuthorityStatus: 'A',
      brokerAuthorityStatus: 'N',
      bipdInsuranceOnFileCents: 100_000_000, // $1,000,000 USD
      bipdInsuranceRequiredCents: 75_000_000,
      cargoInsuranceOnFileCents: 25_000_000, // $250,000 USD
      totalPowerUnits: 24,
      totalDrivers: 28,
      safetyRating: 'S',
      phyCity: 'MONCTON',
      phyState: 'NB',
      phyCountry: 'CA',
      fetchedAt: nowIso,
    };
  }

  if (dotNumber === '999999') {
    return {
      dotNumber: '999999',
      legalName: 'PHANTOM SHELL FREIGHT BROKERAGE LLC',
      dbaName: null,
      allowedToOperate: false,
      statusCode: 'I',
      oosDate: '2026-01-15',
      commonAuthorityStatus: 'I',
      contractAuthorityStatus: 'N',
      brokerAuthorityStatus: 'A',
      bipdInsuranceOnFileCents: 25_000_000, // $250,000 USD (deficient)
      bipdInsuranceRequiredCents: 75_000_000,
      cargoInsuranceOnFileCents: 0,
      totalPowerUnits: 0,
      totalDrivers: 0,
      safetyRating: 'U',
      phyCity: 'WILMINGTON',
      phyState: 'DE',
      phyCountry: 'US',
      fetchedAt: nowIso,
    };
  }

  return null;
}

/**
 * Verifies a carrier against the live US DOT FMCSA QCMobile API with 24h KV caching.
 * - Development without FMCSA_WEB_KEY: serves deterministic dev fixtures for DOT 123456 and 999999.
 * - Production without FMCSA_WEB_KEY: fails closed (`verified: false, reason: 'FMCSA_KEY_UNCONFIGURED'`).
 */
export async function verifyFmcsaCarrier(
  rawDotNumber: string,
  env: Pick<Partial<CloudflareEnv>, 'FMCSA_WEB_KEY' | 'ENVIRONMENT' | 'CACHE'>,
  activeAssignedLoadsCount = 0,
  fetchImpl: typeof fetch = fetch,
): Promise<FmcsaVerificationResult> {
  const parsedDot = DotNumberSchema.safeParse(rawDotNumber);
  if (!parsedDot.success) {
    return {
      verified: false,
      reason: 'INVALID_DOT_NUMBER',
      dotNumber: String(rawDotNumber ?? '').trim(),
      record: null,
      fraudAssessment: null,
      cached: false,
      source: 'error',
      error: parsedDot.error.issues[0]?.message ?? 'Invalid USDOT number.',
    };
  }

  const dotNumber = parsedDot.data;
  const webKey = env.FMCSA_WEB_KEY?.trim();

  if (!webKey) {
    if (env.ENVIRONMENT === 'development') {
      const fixture = getDevelopmentFixture(dotNumber);
      if (!fixture) {
        return {
          verified: false,
          reason: 'CARRIER_NOT_FOUND',
          dotNumber,
          record: null,
          fraudAssessment: null,
          cached: false,
          source: 'dev_fixture',
        };
      }

      const fraudAssessment = evaluateCarrierFraudRisk(fixture, activeAssignedLoadsCount);
      return {
        verified: true,
        reason: 'DEV_FIXTURE',
        dotNumber,
        record: fixture,
        fraudAssessment,
        cached: false,
        source: 'dev_fixture',
      };
    }

    // Fail closed outside development when FMCSA_WEB_KEY is missing
    return {
      verified: false,
      reason: 'FMCSA_KEY_UNCONFIGURED',
      dotNumber,
      record: null,
      fraudAssessment: null,
      cached: false,
      source: 'unconfigured',
    };
  }

  const cacheKey = `fmcsa:carrier:${dotNumber}`;

  if (env.CACHE) {
    try {
      const cachedRecord = (await env.CACHE.get(cacheKey, 'json')) as FmcsaCarrierRecord | null;
      if (cachedRecord && typeof cachedRecord.dotNumber === 'string') {
        const fraudAssessment = evaluateCarrierFraudRisk(cachedRecord, activeAssignedLoadsCount);
        return {
          verified: true,
          reason: 'VERIFIED',
          dotNumber,
          record: cachedRecord,
          fraudAssessment,
          cached: true,
          source: 'fmcsa_qcmobile',
        };
      }
    } catch {
      // Proceed to live lookup if KV read errors
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FMCSA_TIMEOUT_MS);

  try {
    const url = `${FMCSA_QCMOBILE_BASE_URL}/${encodeURIComponent(dotNumber)}?webKey=${encodeURIComponent(webKey)}`;
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'BRO-Transport-Compliance/2026 (+https://brotransport.com)',
      },
      signal: controller.signal,
    });

    if (response.status === 404) {
      return {
        verified: false,
        reason: 'CARRIER_NOT_FOUND',
        dotNumber,
        record: null,
        fraudAssessment: null,
        cached: false,
        source: 'fmcsa_qcmobile',
      };
    }

    if (!response.ok) {
      return {
        verified: false,
        reason: 'FMCSA_UPSTREAM_ERROR',
        dotNumber,
        record: null,
        fraudAssessment: null,
        cached: false,
        source: 'error',
        error: `FMCSA QCMobile returned HTTP ${response.status}`,
      };
    }

    const payload: unknown = await response.json();
    const record = parseFmcsaQcmobileResponse(payload, dotNumber);
    if (!record) {
      return {
        verified: false,
        reason: 'CARRIER_NOT_FOUND',
        dotNumber,
        record: null,
        fraudAssessment: null,
        cached: false,
        source: 'fmcsa_qcmobile',
      };
    }

    if (env.CACHE) {
      try {
        await env.CACHE.put(cacheKey, JSON.stringify(record), {
          expirationTtl: FMCSA_CACHE_TTL_SECONDS,
        });
      } catch {
        // Cache write failure does not invalidate live compliance result
      }
    }

    const fraudAssessment = evaluateCarrierFraudRisk(record, activeAssignedLoadsCount);
    return {
      verified: true,
      reason: 'VERIFIED',
      dotNumber,
      record,
      fraudAssessment,
      cached: false,
      source: 'fmcsa_qcmobile',
    };
  } catch (err) {
    const errorMsg =
      err instanceof Error && err.name === 'AbortError'
        ? `FMCSA QCMobile request timed out after ${FMCSA_TIMEOUT_MS}ms`
        : err instanceof Error
          ? err.message
          : 'FMCSA QCMobile request failed';

    return {
      verified: false,
      reason: 'FMCSA_UPSTREAM_ERROR',
      dotNumber,
      record: null,
      fraudAssessment: null,
      cached: false,
      source: 'error',
      error: errorMsg,
    };
  } finally {
    clearTimeout(timer);
  }
}
