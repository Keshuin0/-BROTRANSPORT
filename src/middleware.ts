import { defineMiddleware } from 'astro:middleware';
import { canAccessRoute } from '@bro/contracts';
import { resolveSessionFromCookie } from '../workers/api/auth.js';

export const onRequest = defineMiddleware(async (context, next) => {
  const env = context.locals.runtime?.env;
  const cookieHeader = context.request.headers.get('cookie');
  const { user, sessionId } = await resolveSessionFromCookie(env, cookieHeader);

  context.locals.user = user;
  context.locals.sessionId = sessionId;

  const { pathname } = context.url;
  const role = user?.role ?? 'visitor';

  const isProtectedPage =
    pathname.startsWith('/ops') ||
    pathname.startsWith('/portal/shipper') ||
    pathname.startsWith('/portal/driver');

  if (isProtectedPage && !canAccessRoute(role, pathname)) {
    if (!user) {
      const nextUrl = encodeURIComponent(pathname + context.url.search);
      return context.redirect(`/login?next=${nextUrl}`, 302);
    }
    return new Response(
      JSON.stringify({
        error: 'Forbidden',
        message: `Role '${role}' is not authorized to access ${pathname}.`,
      }),
      { status: 403, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const response = await next();
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  return response;
});
