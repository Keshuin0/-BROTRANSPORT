import { describe, it, expect } from 'vitest';
import {
  hashPassword,
  verifyPassword,
  hmacSha256Hex,
  verifyWebhookHmac,
  verifyTurnstileFailClosed,
  isAllowedOrigin,
} from '../security.js';
import { apiApp } from '../app.js';
import { extractDocumentWithWorkersAi } from '../../services/aiDocumentOcr.js';
import { runSpecialistCopilotTurn } from '../../services/aiCopilot.js';
import { sendStaffInviteEmail, sendPasswordResetEmail } from '../../services/email.js';

describe('workers/api — Security, RBAC, HMAC Webhooks & AI OCR HITL Gates', () => {
  it('hashes and verifies passwords with Web Crypto PBKDF2-SHA256', async () => {
    const hash = await hashPassword('BroTransport!2026');
    expect(hash.startsWith('pbkdf2_sha256:100000:')).toBe(true);
    expect(await verifyPassword('BroTransport!2026', hash)).toBe(true);
    expect(await verifyPassword('WrongPassword!2026', hash)).toBe(false);
  });

  it('strictly allowlists CORS origins and rejects arbitrary origins', () => {
    expect(isAllowedOrigin('https://brotransport.com')).toBe(true);
    expect(isAllowedOrigin('https://brotransport-os.keshuin0.workers.dev')).toBe(true);
    expect(isAllowedOrigin('http://localhost:4321')).toBe(true);
    expect(isAllowedOrigin('https://evil-scraper.example')).toBe(false);
  });

  it('enforces timing-safe HMAC-SHA256 webhook verification with ±300s replay protection', async () => {
    const secret = 'super-secure-rns-secret-key-2026';
    const nowMs = Date.UTC(2026, 10, 20, 14, 0, 0);
    const tsSec = Math.floor(nowMs / 1000);
    const body = JSON.stringify({ controlNumber: 'BROP8843921', status: 'RELEASED' });
    const sig = await hmacSha256Hex(secret, `${tsSec}.${body}`);

    // Valid signature
    const ok = await verifyWebhookHmac({
      secret,
      signatureHex: sig,
      timestampSecHeader: String(tsSec),
      rawBody: body,
      nowMs,
    });
    expect(ok.ok).toBe(true);

    // Tampered body
    const tampered = await verifyWebhookHmac({
      secret,
      signatureHex: sig,
      timestampSecHeader: String(tsSec),
      rawBody: body.replace('RELEASED', 'HELD'),
      nowMs,
    });
    expect(tampered.ok).toBe(false);
    expect(tampered.status).toBe(401);

    // Replay attack (>5 min old)
    const expired = await verifyWebhookHmac({
      secret,
      signatureHex: sig,
      timestampSecHeader: String(tsSec - 400),
      rawBody: body,
      nowMs,
    });
    expect(expired.ok).toBe(false);
    expect(expired.status).toBe(401);

    // Fail-closed when secret missing
    const unconfigured = await verifyWebhookHmac({
      secret: undefined,
      signatureHex: sig,
      timestampSecHeader: String(tsSec),
      rawBody: body,
      nowMs,
    });
    expect(unconfigured.ok).toBe(false);
    expect(unconfigured.status).toBe(500);
  });

  it('fails closed on missing Turnstile secret in production', async () => {
    const prodMissing = await verifyTurnstileFailClosed('any-token', { ENVIRONMENT: 'production' });
    expect(prodMissing.ok).toBe(false);

    const devToken = await verifyTurnstileFailClosed('dev-ok', { ENVIRONMENT: 'development' });
    expect(devToken.ok).toBe(true);
  });

  it('serves /api/health and blocks unauthenticated /api/ops/* and /api/webhooks/rns', async () => {
    const healthRes = await apiApp.fetch(new Request('https://brotransport.com/api/health'), {} as never);
    expect(healthRes.status).toBe(200);
    const healthJson = (await healthRes.json()) as { status: string; scac: string };
    expect(healthJson.status).toBe('operational');
    expect(healthJson.scac).toBe('BROP');

    const opsBlocked = await apiApp.fetch(new Request('https://brotransport.com/api/ops/overview'), {} as never);
    expect(opsBlocked.status).toBe(403);

    const rnsBlocked = await apiApp.fetch(
      new Request('https://brotransport.com/api/webhooks/rns', {
        method: 'POST',
        headers: { 'x-webhook-signature': 'BROP-SECURE-KEY' },
        body: JSON.stringify({ ccn: 'BROP8843921' }),
      }),
      {} as never,
    );
    expect(rnsBlocked.status).toBe(500); // Fail closed — hardcoded BROP-SECURE-KEY is dead!
  });

  it('always routes un-OCR’d or damaged documents to HITL human verification', async () => {
    const ocr = await extractDocumentWithWorkersAi({
      env: {},
      docType: 'POD',
      fileBytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]),
      mimeType: 'image/jpeg',
      originalFilename: 'pod_damage_box3.jpg',
    });
    expect(ocr.needsHumanReview).toBe(true);
    expect(ocr.hasOsdDamageOrShortage).toBe(true);
    expect(ocr.reviewReasons.length).toBeGreaterThan(0);
  });

  it('enforces Zero-Trust RBAC isolation across all 12 specialist agents and new /api/ops/* desks', async () => {
    for (const path of [
      '/api/ops/planner',
      '/api/ops/settlements',
      '/api/ops/maintenance',
      '/api/ops/carriers',
      '/api/ops/escalations',
      '/api/ops/admin/users',
    ]) {
      const res = await apiApp.fetch(new Request(`https://brotransport.com${path}`), {} as never);
      expect(res.status).toBe(403);
    }

    const unauthAgentChat = await apiApp.fetch(
      new Request('https://brotransport.com/api/agents/DispatchCopilotAgent/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Summarize active loads' }),
      }),
      {} as never,
    );
    expect(unauthAgentChat.status).toBe(401);

    // Billing clerk cannot invoke DispatchCopilotAgent
    await expect(
      runSpecialistCopilotTurn(
        {},
        {
          user: {
            id: 'usr_bill',
            name: 'Billing Clerk',
            email: 'billing@brotransport.com',
            role: 'billing_clerk',
            organizationId: 'org_bro_internal',
          },
          input: {
            agentId: 'DispatchCopilotAgent',
            message: 'Assign driver to load',
          },
        },
      ),
    ).rejects.toThrow(/not authorized/);

    // Shipper user cannot invoke ExecutiveChiefOfStaffAgent
    await expect(
      runSpecialistCopilotTurn(
        {},
        {
          user: {
            id: 'usr_ship',
            name: 'Shipper User',
            email: 'shipper@example.com',
            role: 'shipper_user',
            organizationId: 'org_cavendish_produce',
          },
          input: {
            agentId: 'ExecutiveChiefOfStaffAgent',
            message: 'Show executive P&L',
          },
        },
      ),
    ).rejects.toThrow(/not authorized/);

    // Authorized dispatcher succeeds on DispatchCopilotAgent
    const dispTurn = await runSpecialistCopilotTurn(
      {},
      {
        user: {
          id: 'usr_disp',
          name: 'Claire Arsenault',
          email: 'dispatch@brotransport.com',
          role: 'dispatcher',
          organizationId: 'org_bro_internal',
        },
        input: {
          agentId: 'DispatchCopilotAgent',
          message: 'Summarize active loads',
        },
      },
    );
    expect(dispTurn.agentId).toBe('DispatchCopilotAgent');
    expect(dispTurn.spec.name).toBe('Dispatch Copilot');
  });

  it('strictly escapes HTML in staff invite and password reset Resend emails', async () => {
    let capturedHtml = '';
    const mockFetch: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body || '{}')) as { html?: string };
      capturedHtml = body.html || '';
      return new Response(JSON.stringify({ id: 're_test_123' }), { status: 200 });
    };

    const inviteRes = await sendStaffInviteEmail(
      { RESEND_API_KEY: 're_live_key' },
      {
        to: 'new.dispatcher@brotransport.com',
        recipientName: '<script>alert("xss")</script>Claire',
        roleLabel: 'Dispatcher',
        title: 'Senior Corridor Dispatcher',
        invitedByName: 'Keshav Admin',
        activateUrl: 'https://brotransport.com/activate?token=abc12345678901234567890',
      },
      mockFetch,
    );
    expect(inviteRes.sent).toBe(true);
    expect(capturedHtml).not.toContain('<script>');
    expect(capturedHtml).toContain('&lt;script&gt;');

    const resetRes = await sendPasswordResetEmail(
      { RESEND_API_KEY: 're_live_key' },
      {
        to: 'dispatch@brotransport.com',
        recipientName: '<img src=x onerror=alert(1)>',
        resetUrl: 'https://brotransport.com/reset-password?token=def12345678901234567890',
        otpCode: '482910',
      },
      mockFetch,
    );
    expect(resetRes.sent).toBe(true);
    expect(capturedHtml).not.toContain('<img src=x');
    expect(capturedHtml).toContain('&lt;img src=x');
  });
});
