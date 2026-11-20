import type { APIRoute } from 'astro';
import { apiApp } from '../../../workers/api/app.js';

export const ALL: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime?.env;
  const ctx = locals.runtime?.ctx;
  return apiApp.fetch(request, env, ctx);
};
