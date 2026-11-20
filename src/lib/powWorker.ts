/**
 * Pure Web Crypto SHA-256 Hashcash Proof-of-Work solver for border dead-zone offline submissions.
 * Computes a 16-bit leading-zero SHA-256 token (`timestampSec:nonce:payloadHash`) in ~80–200ms offline
 * so drivers without cell reception can submit forms & documents without needing live Cloudflare Turnstile.
 */
async function sha256Bytes(text: string): Promise<Uint8Array> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return new Uint8Array(buf);
}

function hasLeadingZeroBits(bytes: Uint8Array, bits: number): boolean {
  const fullBytes = Math.floor(bits / 8);
  const remBits = bits % 8;
  for (let i = 0; i < fullBytes; i++) {
    if (bytes[i] !== 0) return false;
  }
  if (remBits > 0) {
    const mask = 0xff << (8 - remBits);
    if ((bytes[fullBytes] & mask) !== 0) return false;
  }
  return true;
}

export async function solveOfflinePow(payloadHashHex: string, difficultyBits = 16): Promise<string> {
  const tsSec = Math.floor(Date.now() / 1000);
  let nonce = 0;
  while (nonce < 2_000_000) {
    const candidate = `${tsSec}:${nonce}:${payloadHashHex}`;
    const digest = await sha256Bytes(candidate);
    if (hasLeadingZeroBits(digest, difficultyBits)) {
      return candidate;
    }
    nonce++;
  }
  throw new Error('Offline PoW solver exceeded iteration ceiling.');
}

// Support execution inside a dedicated Web Worker as well as direct async import
if (typeof self !== 'undefined' && typeof window === 'undefined') {
  self.addEventListener('message', async (evt: MessageEvent<{ payloadHashHex: string; difficultyBits?: number }>) => {
    try {
      const token = await solveOfflinePow(evt.data.payloadHashHex, evt.data.difficultyBits ?? 16);
      self.postMessage({ ok: true, token });
    } catch (err) {
      self.postMessage({ ok: false, error: err instanceof Error ? err.message : 'PoW failed' });
    }
  });
}
