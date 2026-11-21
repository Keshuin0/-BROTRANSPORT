import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { authRoutes, type ApiEnv } from './routes/authRoutes.js';
import { escalationRoutes } from './routes/escalations.js';
import { wsRoutes } from './routes/ws.js';
import { bordersAndQuotesRoutes } from './routes/bordersAndQuotes.js';
import { customsAndRnsRoutes } from './routes/customsAndRns.js';
import { ebolRoutes } from './routes/ebolRoutes.js';
import { driverPortalRoutes } from './routes/driverPortal.js';
import { opsDocumentRoutes } from './routes/opsDocuments.js';
import { shipperPortalRoutes } from './routes/shipperPortal.js';
import { opsDispatchRoutes } from './routes/opsDispatch.js';
import { ediRoutes } from './routes/edi.js';
import { billingAndIftaRoutes } from './routes/billingAndIfta.js';
import { opsAdminRoutes } from './routes/opsAdmin.js';
import { ALLOWED_ORIGINS, isAllowedOrigin } from './security.js';
import { resolveSessionFromCookie } from './auth.js';

export const apiApp = new Hono<ApiEnv>().basePath('/api');

// Strict origin-locked CORS — NEVER uses '*'
apiApp.use(
  '*',
  cors({
    origin: (origin) => (origin && isAllowedOrigin(origin) ? origin : ALLOWED_ORIGINS[0]),
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'x-rns-signature', 'x-rns-timestamp', 'x-edi-signature', 'x-edi-timestamp', 'x-telematics-signature', 'x-telematics-timestamp'],
    credentials: true,
    maxAge: 86400,
  }),
);

// Session resolution on every API request
apiApp.use('*', async (c, next) => {
  const { user, sessionId } = await resolveSessionFromCookie(c.env, c.req.header('cookie'));
  c.set('user', user);
  c.set('sessionId', sessionId);
  await next();
});

// Sanitized global error handler — never leaks stack traces
apiApp.onError((err, c) => {
  console.error('[API_ERROR]', err);
  return c.json({ success: false, error: 'Internal operations gateway error.' }, 500);
});

apiApp.get('/health', (c) =>
  c.json({
    status: 'operational',
    platform: '#BRO Transport Dual-Portal OS',
    scac: c.env?.SCAC_CODE || 'BROP',
    timestamp: Date.now(),
  }),
);

apiApp.route('/auth', authRoutes);
apiApp.route('/', escalationRoutes);
apiApp.route('/', wsRoutes);
apiApp.route('/', bordersAndQuotesRoutes);
apiApp.route('/', customsAndRnsRoutes);
apiApp.route('/', ebolRoutes);
apiApp.route('/', driverPortalRoutes);
apiApp.route('/', opsDocumentRoutes);
apiApp.route('/', shipperPortalRoutes);
apiApp.route('/', opsDispatchRoutes);
apiApp.route('/', ediRoutes);
apiApp.route('/', billingAndIftaRoutes);
apiApp.route('/', opsAdminRoutes);

apiApp.notFound((c) => c.json({ error: 'API endpoint not found', path: c.req.path }, 404));

export default apiApp;
