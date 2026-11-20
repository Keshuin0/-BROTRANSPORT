import type { Currency } from '@bro/contracts';
import type { CloudflareEnv } from '../../src/env';

export const RESEND_API_URL = 'https://api.resend.com/emails';
const DEFAULT_FROM_ADDRESS = '#BRO Transport Corp. <dispatch@brotransport.com>';
const RESEND_TIMEOUT_MS = 8000;

export interface EmailDispatchResult {
  sent: boolean;
  id?: string;
  error?: string;
}

export interface QuoteEmailPayload {
  to: string;
  quoteReference: string;
  contactName: string;
  contactPhone?: string;
  origin: string;
  destination: string;
  equipmentLabel: string;
  distanceKm: number;
  weightLbs: number;
  commodity?: string;
  linehaulCents: number;
  fuelSurchargeCents: number;
  customsBrokerageCents: number;
  accessorialsCents: number;
  totalCents: number;
  currency: Currency;
  estimatedTransitHours: number;
  recommendedPortName?: string | null;
}

export interface EscalationEmailPayload {
  to: string;
  ticketId: string;
  severity: 'high' | 'critical';
  category: string;
  loadReference?: string;
  contactName: string;
  contactChannel: string;
  summary: string;
}

export interface InvoiceEmailPayload {
  to: string;
  invoiceNumber: string;
  shipperName: string;
  loadReference: string;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  currency: Currency;
  taxLabel: string;
  dueDateIso: string;
  paymentPortalUrl?: string;
}

export interface OtpEmailPayload {
  to: string;
  recipientName?: string;
  otpCode: string;
  expiresInMinutes?: number;
  purpose?: string;
}

const HTML_ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Escapes HTML special characters to neutralize XSS/HTML injection in transactional emails.
 */
export function escapeHtml(str: string): string {
  return String(str ?? '').replace(/[&<>"']/g, (ch) => HTML_ESCAPE_MAP[ch] ?? ch);
}

function sanitizeHeaderText(str: string): string {
  return String(str ?? '')
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

function sanitizeSafeHttpUrl(rawUrl?: string): string | null {
  if (!rawUrl) return null;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      return parsed.toString();
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Formats integer cents for presentation only.
 */
function formatMoneyFromCents(cents: number, currency: Currency): string {
  const safeCents = Math.trunc(cents);
  const sign = safeCents < 0 ? '-' : '';
  const abs = Math.abs(safeCents);
  const whole = Math.floor(abs / 100).toLocaleString('en-US');
  const frac = String(abs % 100).padStart(2, '0');
  return `${sign}$${whole}.${frac} ${currency}`;
}

function renderCorporateEmailShell(title: string, bodyHtml: string): string {
  const safeTitle = escapeHtml(title);
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8" /><title>${safeTitle}</title></head>
<body style="margin:0;padding:24px;background:#0b1120;color:#e2e8f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:640px;margin:0 auto;background:#111827;border:1px solid #1e293b;border-radius:10px;overflow:hidden;">
    <div style="padding:20px 24px;background:#0f172a;border-bottom:1px solid #1e293b;">
      <div style="font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:#38bdf8;font-weight:700;">#BRO TRANSPORT CORP.</div>
      <h1 style="margin:6px 0 0;font-size:20px;color:#f8fafc;">${safeTitle}</h1>
    </div>
    <div style="padding:24px;line-height:1.55;font-size:14px;color:#cbd5e1;">
      ${bodyHtml}
    </div>
    <div style="padding:16px 24px;background:#0f172a;border-top:1px solid #1e293b;font-size:12px;color:#64748b;">
      #BRO Transport Corp. &bull; Commercial Cross-Border Freight (Dry Van &bull; Reefer &bull; Flatbed) &bull; SCAC: BROP
    </div>
  </div>
</body>
</html>`;
}

async function sendResendEmail(
  env: Pick<Partial<CloudflareEnv>, 'RESEND_API_KEY'>,
  params: { to: string; subject: string; html: string; from?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<EmailDispatchResult> {
  const apiKey = env.RESEND_API_KEY?.trim();
  if (!apiKey) {
    return { sent: false, error: 'RESEND_API_KEY_UNCONFIGURED' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RESEND_TIMEOUT_MS);

  try {
    const response = await fetchImpl(RESEND_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: params.from ?? DEFAULT_FROM_ADDRESS,
        to: [sanitizeHeaderText(params.to)],
        subject: sanitizeHeaderText(params.subject),
        html: params.html,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      const detail = errBody.trim() || response.statusText || 'Request rejected';
      return {
        sent: false,
        error: `Resend HTTP ${response.status}: ${detail}`,
      };
    }

    const data = (await response.json().catch(() => ({}))) as { id?: string };
    return {
      sent: true,
      id: typeof data.id === 'string' ? data.id : undefined,
    };
  } catch (err) {
    const message =
      err instanceof Error && err.name === 'AbortError'
        ? `Resend API timed out after ${RESEND_TIMEOUT_MS}ms`
        : err instanceof Error
          ? err.message
          : 'Unknown email dispatch failure';
    return { sent: false, error: message };
  } finally {
    clearTimeout(timer);
  }
}

export async function sendQuoteEmail(
  env: Pick<Partial<CloudflareEnv>, 'RESEND_API_KEY'>,
  payload: QuoteEmailPayload,
  fetchImpl: typeof fetch = fetch,
): Promise<EmailDispatchResult> {
  const ref = escapeHtml(payload.quoteReference);
  const contactName = escapeHtml(payload.contactName);
  const contactPhone = payload.contactPhone ? escapeHtml(payload.contactPhone) : 'Not provided';
  const origin = escapeHtml(payload.origin);
  const destination = escapeHtml(payload.destination);
  const equipment = escapeHtml(payload.equipmentLabel);
  const commodity = escapeHtml(payload.commodity ?? 'General Commercial Freight');
  const portRow = payload.recommendedPortName
    ? `<tr><td style="padding:6px 0;color:#94a3b8;">Recommended Port</td><td style="padding:6px 0;color:#f8fafc;text-align:right;">${escapeHtml(payload.recommendedPortName)}</td></tr>`
    : '';

  const html = renderCorporateEmailShell(
    `Commercial Freight Quote #${payload.quoteReference}`,
    `<p>Hello ${contactName},</p>
     <p>Your commercial freight rate evaluation has been logged with #BRO Transport Dispatch.</p>
     <table style="width:100%;border-collapse:collapse;margin:16px 0;border-top:1px solid #1e293b;border-bottom:1px solid #1e293b;">
       <tr><td style="padding:6px 0;color:#94a3b8;">Reference</td><td style="padding:6px 0;color:#f8fafc;text-align:right;font-weight:600;">${ref}</td></tr>
       <tr><td style="padding:6px 0;color:#94a3b8;">Corridor</td><td style="padding:6px 0;color:#f8fafc;text-align:right;">${origin} &rarr; ${destination}</td></tr>
       <tr><td style="padding:6px 0;color:#94a3b8;">Equipment</td><td style="padding:6px 0;color:#f8fafc;text-align:right;">${equipment}</td></tr>
       <tr><td style="padding:6px 0;color:#94a3b8;">Commodity / Weight</td><td style="padding:6px 0;color:#f8fafc;text-align:right;">${commodity} (${Math.round(payload.weightLbs).toLocaleString('en-US')} lbs)</td></tr>
       <tr><td style="padding:6px 0;color:#94a3b8;">Distance / Est. Transit</td><td style="padding:6px 0;color:#f8fafc;text-align:right;">${Math.round(payload.distanceKm).toLocaleString('en-US')} km &bull; ~${Math.round(payload.estimatedTransitHours)} hrs</td></tr>
       ${portRow}
       <tr><td style="padding:6px 0;color:#94a3b8;">Linehaul</td><td style="padding:6px 0;color:#f8fafc;text-align:right;">${escapeHtml(formatMoneyFromCents(payload.linehaulCents, payload.currency))}</td></tr>
       <tr><td style="padding:6px 0;color:#94a3b8;">Fuel Surcharge</td><td style="padding:6px 0;color:#f8fafc;text-align:right;">${escapeHtml(formatMoneyFromCents(payload.fuelSurchargeCents, payload.currency))}</td></tr>
       <tr><td style="padding:6px 0;color:#94a3b8;">Customs Coordination</td><td style="padding:6px 0;color:#f8fafc;text-align:right;">${escapeHtml(formatMoneyFromCents(payload.customsBrokerageCents, payload.currency))}</td></tr>
       <tr><td style="padding:6px 0;color:#94a3b8;">Accessorials</td><td style="padding:6px 0;color:#f8fafc;text-align:right;">${escapeHtml(formatMoneyFromCents(payload.accessorialsCents, payload.currency))}</td></tr>
       <tr><td style="padding:10px 0;color:#38bdf8;font-weight:700;">Total Estimate</td><td style="padding:10px 0;color:#38bdf8;text-align:right;font-weight:700;font-size:16px;">${escapeHtml(formatMoneyFromCents(payload.totalCents, payload.currency))}</td></tr>
     </table>
     <p style="font-size:12px;color:#94a3b8;">Callback Contact: ${contactPhone}</p>`,
  );

  return sendResendEmail(
    env,
    {
      to: payload.to,
      subject: `#BRO Transport Quote #${sanitizeHeaderText(payload.quoteReference)} — ${sanitizeHeaderText(payload.origin)} to ${sanitizeHeaderText(payload.destination)}`,
      html,
    },
    fetchImpl,
  );
}

export async function sendEscalationEmail(
  env: Pick<Partial<CloudflareEnv>, 'RESEND_API_KEY'>,
  payload: EscalationEmailPayload,
  fetchImpl: typeof fetch = fetch,
): Promise<EmailDispatchResult> {
  const severityBadgeColor = payload.severity === 'critical' ? '#ef4444' : '#f59e0b';
  const safeTicket = escapeHtml(payload.ticketId);
  const safeSeverity = escapeHtml(payload.severity.toUpperCase());
  const safeCategory = escapeHtml(payload.category);
  const safeLoadRef = payload.loadReference ? escapeHtml(payload.loadReference) : 'Unassigned';
  const safeContactName = escapeHtml(payload.contactName);
  const safeChannel = escapeHtml(payload.contactChannel);
  const safeSummary = escapeHtml(payload.summary);

  const html = renderCorporateEmailShell(
    `Executive Ally Escalation [${payload.severity.toUpperCase()}] #${payload.ticketId}`,
    `<p style="margin-top:0;">
       <span style="display:inline-block;padding:4px 10px;border-radius:4px;background:${severityBadgeColor};color:#ffffff;font-weight:700;font-size:12px;">${safeSeverity}</span>
       <strong style="margin-left:8px;color:#f8fafc;">Ticket ${safeTicket}</strong>
     </p>
     <table style="width:100%;border-collapse:collapse;margin:16px 0;">
       <tr><td style="padding:6px 0;color:#94a3b8;">Category</td><td style="padding:6px 0;color:#f8fafc;text-align:right;">${safeCategory}</td></tr>
       <tr><td style="padding:6px 0;color:#94a3b8;">Load Reference</td><td style="padding:6px 0;color:#f8fafc;text-align:right;">${safeLoadRef}</td></tr>
       <tr><td style="padding:6px 0;color:#94a3b8;">Submitted By</td><td style="padding:6px 0;color:#f8fafc;text-align:right;">${safeContactName}</td></tr>
       <tr><td style="padding:6px 0;color:#94a3b8;">Callback Channel</td><td style="padding:6px 0;color:#f8fafc;text-align:right;">${safeChannel}</td></tr>
     </table>
     <div style="padding:14px;background:#0f172a;border:1px solid #334155;border-radius:6px;white-space:pre-wrap;color:#e2e8f0;">${safeSummary}</div>`,
  );

  return sendResendEmail(
    env,
    {
      to: payload.to,
      subject: `[${sanitizeHeaderText(payload.severity.toUpperCase())}] Escalation #${sanitizeHeaderText(payload.ticketId)} — ${sanitizeHeaderText(payload.category)}`,
      html,
    },
    fetchImpl,
  );
}

export async function sendInvoiceEmail(
  env: Pick<Partial<CloudflareEnv>, 'RESEND_API_KEY'>,
  payload: InvoiceEmailPayload,
  fetchImpl: typeof fetch = fetch,
): Promise<EmailDispatchResult> {
  const safeInvoice = escapeHtml(payload.invoiceNumber);
  const safeShipper = escapeHtml(payload.shipperName);
  const safeLoad = escapeHtml(payload.loadReference);
  const safeTaxLabel = escapeHtml(payload.taxLabel);
  const safeDueDate = escapeHtml(payload.dueDateIso);
  const safePortalUrl = sanitizeSafeHttpUrl(payload.paymentPortalUrl);

  const portalBlock = safePortalUrl
    ? `<p style="margin-top:20px;"><a href="${escapeHtml(safePortalUrl)}" style="display:inline-block;padding:10px 18px;background:#0284c7;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600;">View Invoice &amp; POD Packet</a></p>`
    : '';

  const html = renderCorporateEmailShell(
    `Freight Invoice #${payload.invoiceNumber}`,
    `<p>Dear ${safeShipper},</p>
     <p>Please find your commercial freight invoice summary for load <strong>${safeLoad}</strong>.</p>
     <table style="width:100%;border-collapse:collapse;margin:16px 0;border-top:1px solid #1e293b;border-bottom:1px solid #1e293b;">
       <tr><td style="padding:6px 0;color:#94a3b8;">Invoice Number</td><td style="padding:6px 0;color:#f8fafc;text-align:right;">${safeInvoice}</td></tr>
       <tr><td style="padding:6px 0;color:#94a3b8;">Load Reference</td><td style="padding:6px 0;color:#f8fafc;text-align:right;">${safeLoad}</td></tr>
       <tr><td style="padding:6px 0;color:#94a3b8;">Due Date</td><td style="padding:6px 0;color:#f8fafc;text-align:right;">${safeDueDate}</td></tr>
       <tr><td style="padding:6px 0;color:#94a3b8;">Subtotal</td><td style="padding:6px 0;color:#f8fafc;text-align:right;">${escapeHtml(formatMoneyFromCents(payload.subtotalCents, payload.currency))}</td></tr>
       <tr><td style="padding:6px 0;color:#94a3b8;">${safeTaxLabel}</td><td style="padding:6px 0;color:#f8fafc;text-align:right;">${escapeHtml(formatMoneyFromCents(payload.taxCents, payload.currency))}</td></tr>
       <tr><td style="padding:10px 0;color:#38bdf8;font-weight:700;">Amount Due</td><td style="padding:10px 0;color:#38bdf8;text-align:right;font-weight:700;font-size:16px;">${escapeHtml(formatMoneyFromCents(payload.totalCents, payload.currency))}</td></tr>
     </table>
     ${portalBlock}`,
  );

  return sendResendEmail(
    env,
    {
      to: payload.to,
      subject: `#BRO Transport Invoice #${sanitizeHeaderText(payload.invoiceNumber)} — Due ${sanitizeHeaderText(payload.dueDateIso)}`,
      html,
    },
    fetchImpl,
  );
}

export async function sendOtpEmail(
  env: Pick<Partial<CloudflareEnv>, 'RESEND_API_KEY'>,
  payload: OtpEmailPayload,
  fetchImpl: typeof fetch = fetch,
): Promise<EmailDispatchResult> {
  const safeName = payload.recipientName ? escapeHtml(payload.recipientName) : 'Authorized User';
  const safeCode = escapeHtml(payload.otpCode);
  const safePurpose = escapeHtml(payload.purpose ?? 'Portal Sign-In Verification');
  const expiresMinutes = Math.max(1, Math.round(payload.expiresInMinutes ?? 10));

  const html = renderCorporateEmailShell(
    'One-Time Security Verification Code',
    `<p>Hello ${safeName},</p>
     <p>Use the verification code below to complete <strong>${safePurpose}</strong>:</p>
     <div style="margin:20px 0;padding:16px;text-align:center;background:#0f172a;border:1px solid #38bdf8;border-radius:8px;font-size:28px;letter-spacing:0.28em;font-weight:700;color:#f8fafc;font-family:monospace;">
       ${safeCode}
     </div>
     <p style="font-size:12px;color:#94a3b8;">This code expires in ${expiresMinutes} minutes. If you did not request this verification, ignore this email and alert Security Operations.</p>`,
  );

  return sendResendEmail(
    env,
    {
      to: payload.to,
      subject: `#BRO Transport Security Code — ${sanitizeHeaderText(payload.purpose ?? 'Verification')}`,
      html,
    },
    fetchImpl,
  );
}
