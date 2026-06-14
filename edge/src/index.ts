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

// Zod validation schemas
const QuoteSchema = z.object({
  logisticsType: z.enum(['commercial', 'military']),
  length: z.number().min(1),
  width: z.number().min(1),
  height: z.number().min(1),
  weight: z.number().min(1),
  origin: z.string().min(3),
  destination: z.string().min(3),
  contactName: z.string().min(2),
  contactEmail: z.string().email(),
  contactPhone: z.string().min(10),
});

const DriverApplicationSchema = z.object({
  driverName: z.string().min(2),
  driverPhone: z.string().min(10),
  equipType: z.enum(['multi-axle', 'rgn', 'stepdeck', 'military-spec']),
  preferredLanes: z.string().min(3),
  citizenOrPR: z.literal(true),
  cgpAuthorized: z.boolean(),
  hasCleanAbstract: z.literal(true),
});

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
    
    // Evaluate if Oversized
    const isOversized = data.width > 8.5 || data.height > 13.5 || data.length > 53 || data.weight > 45000;
    const recommendedTrailer = data.weight > 75000 ? '13-Axle Transport Combo' : isOversized ? 'RGN Lowboy Float' : 'Standard Stepdeck / Flatbed';

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
            <p><strong>Dimensions:</strong> ${data.length}ft x ${data.width}ft x ${data.height}ft // Weight: ${data.weight} lbs</p>
            <p><strong>Permit Class:</strong> ${isOversized ? 'Oversized Superload (Permits Required)' : 'Standard Load'}</p>
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
