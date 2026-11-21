import type { CloudflareEnv } from '../../src/env.js';

export const ALLOWED_ORIGINS = [
  'https://brotransport.com',
  'https://www.brotransport.com',
  'https://brotransport-os.keshuin0.workers.dev',
  'http://localhost:4321',
  'http://127.0.0.1:4321',
  'http://localhost:8787',
  'http://127.0.0.1:8787',
] as const;

export function isAllowedOrigin(origin: string | undefined | null): boolean {
  if (!origin) return true; // Same-origin or server-to-server request
  return (ALLOWED_ORIGINS as readonly string[]).includes(origin);
}

/** Constant-time byte comparison to prevent timing side-channel attacks. */
export function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

export function hexToBytes(hex: string): Uint8Array | null {
  const clean = hex.trim().toLowerCase();
  if (clean.length % 2 !== 0 || !/^[0-9a-f]+$/.test(clean)) return null;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return bytesToHex(new Uint8Array(sig));
}

/**
 * Verifies an HMAC-SHA256 webhook signature over `${timestampSec}.${rawBody}`
 * with mandatory ±300s replay-window enforcement and constant-time comparison.
 */
export async function verifyWebhookHmac(params: {
  secret: string | undefined;
  signatureHex: string | undefined;
  timestampSecHeader: string | undefined;
  rawBody: string;
  nowMs?: number;
  maxSkewSec?: number;
}): Promise<{ ok: boolean; status: 200 | 401 | 500; error?: string }> {
  if (!params.secret || params.secret.trim().length < 16) {
    return { ok: false, status: 500, error: 'Webhook verification secret is not configured.' };
  }
  if (!params.signatureHex || !params.timestampSecHeader) {
    return { ok: false, status: 401, error: 'Missing required webhook signature or timestamp headers.' };
  }

  const tsSec = Number(params.timestampSecHeader);
  if (!Number.isFinite(tsSec)) {
    return { ok: false, status: 401, error: 'Invalid webhook timestamp header.' };
  }

  const nowSec = Math.floor((params.nowMs ?? Date.now()) / 1000);
  const maxSkew = params.maxSkewSec ?? 300;
  if (Math.abs(nowSec - tsSec) > maxSkew) {
    return { ok: false, status: 401, error: 'Webhook timestamp outside allowed ±300s replay window.' };
  }

  const expectedHex = await hmacSha256Hex(params.secret, `${tsSec}.${params.rawBody}`);
  const expectedBytes = hexToBytes(expectedHex);
  const providedBytes = hexToBytes(params.signatureHex.replace(/^sha256=/i, ''));

  if (!expectedBytes || !providedBytes || !timingSafeEqualBytes(expectedBytes, providedBytes)) {
    return { ok: false, status: 401, error: 'Invalid cryptographic webhook signature.' };
  }
  return { ok: true, status: 200 };
}

/**
 * Fail-closed Cloudflare Turnstile verifier.
 * NEVER falls back to an always-pass test key in production!
 */
export async function verifyTurnstileFailClosed(
  token: string | undefined,
  env: Partial<CloudflareEnv>,
  remoteIp?: string,
): Promise<{ ok: boolean; error?: string }> {
  const isDev = env.ENVIRONMENT === 'development' || env.ENVIRONMENT === 'test';
  const secret = env.TURNSTILE_SECRET_KEY;

  if (!secret) {
    if (isDev) {
      return token && token.length > 0
        ? { ok: true }
        : { ok: false, error: 'Security verification token required.' };
    }
    return { ok: false, error: 'Turnstile security secret is not configured.' };
  }

  if (!token || token.trim().length === 0) {
    return { ok: false, error: 'Please complete the Cloudflare Turnstile security check.' };
  }

  const formData = new FormData();
  formData.append('secret', secret);
  formData.append('response', token);
  if (remoteIp) formData.append('remoteip', remoteIp);

  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: formData,
    });
    const outcome = (await res.json()) as { success?: boolean };
    return outcome.success
      ? { ok: true }
      : { ok: false, error: 'Security challenge verification failed.' };
  } catch {
    return { ok: false, error: 'Unable to reach security verification gateway.' };
  }
}

/** Fixed-window KV rate limiter (defaults to 60 req / 60s per key). */
export async function checkRateLimit(
  kv: KVNamespace | undefined,
  key: string,
  limit = 60,
  windowSec = 60,
): Promise<{ allowed: boolean; remaining: number }> {
  if (!kv) return { allowed: true, remaining: limit };
  const bucket = Math.floor(Date.now() / 1000 / windowSec);
  const fullKey = `rl:${key}:${bucket}`;
  const currentRaw = await kv.get(fullKey);
  const current = currentRaw ? Number(currentRaw) : 0;
  if (current >= limit) {
    return { allowed: false, remaining: 0 };
  }
  await kv.put(fullKey, String(current + 1), { expirationTtl: windowSec + 10 });
  return { allowed: true, remaining: Math.max(0, limit - current - 1) };
}

/** PBKDF2-SHA256 Web Crypto password hashing (100k iterations, salt included). */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' },
    baseKey,
    256,
  );
  return `pbkdf2_sha256:100000:${bytesToHex(salt)}:${bytesToHex(new Uint8Array(derived))}`;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const parts = storedHash.split(':');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2_sha256') return false;
  const iterations = Number(parts[1]);
  const salt = hexToBytes(parts[2]);
  const expected = hexToBytes(parts[3]);
  if (!salt || !expected || !Number.isFinite(iterations)) return false;

  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    baseKey,
    256,
  );
  return timingSafeEqualBytes(new Uint8Array(derived), expected);
}
