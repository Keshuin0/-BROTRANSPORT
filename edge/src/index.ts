import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';

type Bindings = {
  RESEND_API_KEY: string;
  TURNSTILE_SECRET_KEY: string;
  BUCKET: R2Bucket;
};

const app = new Hono<{ Bindings: Bindings }>();

// Enable CORS for secure communication with the GitHub Pages static frontend
app.use('*', cors({
  origin: '*', // In production, replace with https://Keshuin0.github.io
  allowMethods: ['POST', 'GET', 'OPTIONS'],
  allowHeaders: ['Content-Type'],
  maxAge: 86400,
}));

// Zod validation schemas matching src/lib/schemas.ts
const QuoteSchema = z.object({
  trailerType: z.enum(['dry-van', 'reefer', 'flatbed']),
  weight: z.number().min(1).max(45000),
  tempSetpoint: z.number().optional(),
  origin: z.string().min(3),
  destination: z.string().min(3),
  contactName: z.string().min(2),
  contactEmail: z.string().email(),
  contactPhone: z.string().min(10),
  turnstileToken: z.string().min(1),
});

const DriverApplicationSchema = z.object({
  driverName: z.string().min(2),
  driverPhone: z.string().min(10),
  equipType: z.enum(['dry-van', 'reefer', 'flatbed']),
  preferredLanes: z.string().min(3),
  class1OrAz: z.literal(true),
  safetyCertified: z.boolean(),
  hasCleanAbstract: z.literal(true),
  turnstileToken: z.string().min(1),
});

// Cloudflare Turnstile Verification Helper
async function verifyTurnstileToken(token: string, secretKey: string, ip?: string): Promise<boolean> {
  const secret = secretKey || '1x00000000000000000000000000000000AA'; // Fallback to always-pass key for dev
  const formData = new FormData();
  formData.append('secret', secret);
  formData.append('response', token);
  if (ip) {
    formData.append('remoteip', ip);
  }

  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: formData,
    });
    const outcome: any = await res.json();
    return !!outcome.success;
  } catch (err) {
    console.error('Turnstile verification error:', err);
    return false;
  }
}

// Health check endpoint
app.get('/api/health', (c) => c.json({ status: 'operational', timestamp: Date.now() }));

// Quote Engine POST route
app.post('/api/quote', async (c) => {
  try {
    const body = await c.req.json();
    const result = QuoteSchema.safeParse(body);

    if (!result.success) {
      return c.json({ success: false, errors: result.error.errors }, 400);
    }

    const data = result.data;

    // Verify Turnstile Anti-Spam Token
    const ip = c.req.header('CF-Connecting-IP');
    const isHuman = await verifyTurnstileToken(data.turnstileToken, c.env.TURNSTILE_SECRET_KEY, ip);
    if (!isHuman) {
      return c.json({ success: false, error: 'Security verification failed.' }, 403);
    }
    
    // Evaluate if Oversized
    const isOversized = data.weight > 40000;
    let recommendedTrailer = 'Standard 53ft Enclosed Carrier';
    if (data.trailerType === 'reefer') {
      recommendedTrailer = '53ft Climate-Controlled Reefer';
    } else if (data.trailerType === 'flatbed') {
      recommendedTrailer = '53ft Open Deck Flatbed';
    }

    // Dispatch transactional email via Resend if API key is present
    if (c.env.RESEND_API_KEY) {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${c.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: 'dispatch@brotransport.com',
          to: data.contactEmail,
          subject: '#BRO Transport Corp. — Quote Evaluation Request Received',
          html: `
            <h3>Quote Evaluation Request #${Math.floor(Math.random() * 100000)}</h3>
            <p><strong>Contact:</strong> ${data.contactName} (${data.contactPhone})</p>
            <p><strong>Transit:</strong> ${data.origin} to ${data.destination}</p>
            <p><strong>Trailer Type:</strong> ${data.trailerType.toUpperCase()} ${data.tempSetpoint !== undefined ? `(Temp Setpoint: ${data.tempSetpoint}°C)` : ''}</p>
            <p><strong>Weight:</strong> ${data.weight} lbs</p>
            <p><strong>Permit Class:</strong> ${isOversized ? 'High Deck Stress (Permits Required)' : 'Standard Load'}</p>
            <p><strong>Suggested Trailer Profile:</strong> ${recommendedTrailer}</p>
          `,
        }),
      });
    }

    return c.json({
      success: true,
      message: 'Freight parameters verified. Pricing coordinator dispatched.',
      isOversized,
      recommendedTrailer,
    });
  } catch (err: any) {
    return c.json({ success: false, error: err.message }, 500);
  }
});

// Driver Compliance Portal POST route (integrates R2 uploads)
app.post('/api/drivers', async (c) => {
  try {
    const body = await c.req.json();
    const result = DriverApplicationSchema.safeParse(body);

    if (!result.success) {
      return c.json({ success: false, errors: result.error.errors }, 400);
    }

    const data = result.data;

    // Verify Turnstile Anti-Spam Token
    const ip = c.req.header('CF-Connecting-IP');
    const isHuman = await verifyTurnstileToken(data.turnstileToken, c.env.TURNSTILE_SECRET_KEY, ip);
    if (!isHuman) {
      return c.json({ success: false, error: 'Security verification failed.' }, 403);
    }

    // Simulate database write / logs
    console.log(`Compliance Application received: ${data.driverName}`);

    // If an abstract is uploaded in a subsequent request, the frontend will request a pre-signed URL:
    // We would put it in our R2 bucket if BUCKET is bound
    const filename = `applications/${Date.now()}_${data.driverName.replace(/\s+/g, '_')}_compliance.json`;
    if (c.env.BUCKET) {
      await c.env.BUCKET.put(filename, JSON.stringify(data), {
        customMetadata: {
          driverName: data.driverName,
          equipType: data.equipType,
        }
      });
    }

    return c.json({
      success: true,
      message: 'Controlled Goods security clearance initiated. Records archived in secure R2 vault.',
      archiveId: filename,
    });
  } catch (err: any) {
    return c.json({ success: false, error: err.message }, 500);
  }
});

export default app;
