import { defineMiddleware } from 'astro:middleware';
import { canAccessRoute, defaultHomeForRole, isOpsRole, type UserRole } from '@bro/contracts';
import { resolveSessionFromCookie } from '../workers/api/auth.js';

const HTML_ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(value: string): string {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => HTML_ESCAPE_MAP[ch] ?? ch);
}

function renderForbiddenHtml(params: {
  pathname: string;
  role: UserRole;
  userName: string;
  userEmail: string;
}): string {
  const safePath = escapeHtml(params.pathname);
  const safeRole = escapeHtml(params.role.replace(/_/g, ' '));
  const safeName = escapeHtml(params.userName);
  const safeEmail = escapeHtml(params.userEmail);
  const homeHref = defaultHomeForRole(params.role);
  const safeHomeHref = escapeHtml(homeHref);

  const homeLabel = isOpsRole(params.role)
    ? 'Return to Ops Control Tower'
    : params.role === 'carrier_driver'
      ? 'Return to Driver PWA'
      : params.role.startsWith('shipper')
        ? 'Return to Shipper Portal'
        : 'Return to Command Center';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <meta name="theme-color" content="#020308" />
    <title>403 Access Restricted | #BRO Transport Corp.</title>
    <style>
      :root { color-scheme: dark; }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
        background-color: #020308;
        background-image:
          radial-gradient(ellipse 75% 55% at 72% 8%, rgba(0, 240, 255, 0.085), transparent 65%),
          radial-gradient(ellipse 60% 45% at 18% 92%, rgba(255, 170, 0, 0.055), transparent 65%);
        color: #eef4fb;
        font-family: 'Plus Jakarta Sans', ui-sans-serif, system-ui, -apple-system, sans-serif;
        -webkit-font-smoothing: antialiased;
      }
      .card {
        width: 100%;
        max-width: 600px;
        background: linear-gradient(180deg, #0b1120 0%, #070b16 100%);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 24px;
        padding: 32px;
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.07), 0 24px 60px -16px rgba(0, 0, 0, 0.8);
      }
      .badge {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 6px 12px;
        border-radius: 9999px;
        background: rgba(255, 0, 85, 0.12);
        border: 1px solid rgba(255, 0, 85, 0.35);
        color: #fda4af;
        font-family: ui-monospace, 'SFMono-Regular', Menlo, monospace;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      h1 {
        margin: 18px 0 10px;
        font-size: clamp(1.6rem, 3vw, 2.2rem);
        line-height: 1.1;
        letter-spacing: -0.025em;
        color: #ffffff;
      }
      p {
        margin: 0 0 18px;
        font-size: 14px;
        line-height: 1.6;
        color: #cbd5e1;
      }
      .meta {
        margin: 20px 0 24px;
        padding: 16px;
        border-radius: 16px;
        background: #060913;
        border: 1px solid rgba(255, 255, 255, 0.08);
        font-family: ui-monospace, 'SFMono-Regular', Menlo, monospace;
        font-size: 12px;
        display: grid;
        gap: 8px;
      }
      .row {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        flex-wrap: wrap;
      }
      .label { color: #94a3b8; }
      .val { color: #f8fafc; font-weight: 600; word-break: break-word; }
      .val-role { color: #ffaa00; text-transform: capitalize; }
      .val-path { color: #00f0ff; }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        align-items: center;
      }
      .btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 44px;
        padding: 10px 20px;
        border-radius: 9999px;
        font-size: 13px;
        font-weight: 600;
        text-decoration: none;
        cursor: pointer;
        border: 1px solid transparent;
        transition: background-color 150ms ease, border-color 150ms ease;
      }
      .btn-primary {
        background: #00f0ff;
        color: #020308;
      }
      .btn-primary:hover { background: #67e8f9; }
      .btn-secondary {
        background: rgba(255, 255, 255, 0.05);
        border-color: rgba(255, 255, 255, 0.16);
        color: #f8fafc;
      }
      .btn-secondary:hover { border-color: rgba(255, 255, 255, 0.35); }
      .btn-logout {
        background: rgba(136, 19, 55, 0.35);
        border-color: rgba(244, 63, 94, 0.4);
        color: #fecdd3;
        font-family: inherit;
      }
      .btn-logout:hover { background: rgba(136, 19, 55, 0.65); }
    </style>
  </head>
  <body>
    <main class="card" role="main">
      <div class="badge">HTTP 403 · Zero-Trust RBAC Gate</div>
      <h1>Role Clearance Required</h1>
      <p>
        Your active session does not include permission to access this protected workspace.
        Return to your authorized portal or sign out to authenticate with a different account.
      </p>

      <div class="meta">
        <div class="row">
          <span class="label">Signed-In Account</span>
          <span class="val">${safeName} (${safeEmail})</span>
        </div>
        <div class="row">
          <span class="label">Current Role</span>
          <span class="val val-role">${safeRole}</span>
        </div>
        <div class="row">
          <span class="label">Requested Route</span>
          <span class="val val-path">${safePath}</span>
        </div>
      </div>

      <div class="actions">
        <a class="btn btn-primary" href="${safeHomeHref}">${escapeHtml(homeLabel)} →</a>
        <a class="btn btn-secondary" href="/">Command Center</a>
        <form method="POST" action="/api/auth/logout" style="margin:0;">
          <button type="submit" class="btn btn-logout">Sign Out &amp; Switch Account</button>
        </form>
      </div>
    </main>
  </body>
</html>`;
}

export const onRequest = defineMiddleware(async (context, next) => {
  const env = context.locals.runtime?.env;
  const cookieHeader = context.request.headers.get('cookie');
  const { user, sessionId } = await resolveSessionFromCookie(env, cookieHeader);

  context.locals.user = user;
  context.locals.sessionId = sessionId;

  const { pathname } = context.url;
  const lowerPath = pathname.toLowerCase();
  const role: UserRole = user?.role ?? 'visitor';

  const isProtectedPage =
    lowerPath.startsWith('/ops') ||
    lowerPath.startsWith('/portal/shipper') ||
    lowerPath.startsWith('/portal/driver');

  if (isProtectedPage && !canAccessRoute(role, pathname)) {
    const acceptHeader = context.request.headers.get('accept') ?? '';
    const wantsJson =
      lowerPath.startsWith('/api/') ||
      (acceptHeader.includes('application/json') && !acceptHeader.includes('text/html'));

    if (!user || user.role === 'visitor') {
      if (wantsJson) {
        return new Response(
          JSON.stringify({
            error: 'Unauthorized',
            message: 'Authentication required to access this protected route.',
          }),
          {
            status: 401,
            headers: {
              'Content-Type': 'application/json',
              'Cache-Control': 'no-store',
              'X-Content-Type-Options': 'nosniff',
            },
          },
        );
      }
      const nextUrl = encodeURIComponent(pathname + context.url.search);
      return context.redirect(`/login?next=${nextUrl}`, 302);
    }

    if (wantsJson) {
      return new Response(
        JSON.stringify({
          error: 'Forbidden',
          message: `Role '${role}' is not authorized to access ${pathname}.`,
        }),
        {
          status: 403,
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
          },
        },
      );
    }

    return new Response(
      renderForbiddenHtml({
        pathname,
        role,
        userName: user.name,
        userEmail: user.email,
      }),
      {
        status: 403,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'X-Frame-Options': 'DENY',
          'Referrer-Policy': 'strict-origin-when-cross-origin',
        },
      },
    );
  }

  const response = await next();
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  return response;
});
