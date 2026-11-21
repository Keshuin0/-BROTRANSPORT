import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import mdx from '@astrojs/mdx';
import react from '@astrojs/react';
import tailwind from '@tailwindcss/vite';
import pwa from '@vite-pwa/astro';

export default defineConfig({
  output: 'server',
  adapter: cloudflare({
    platformProxy: {
      enabled: true,
    },
    imageService: 'compile',
    sessionKVBindingName: 'CACHE',
    workerEntryPoint: {
      path: 'workers/workerEntry.ts',
      namedExports: [
        'OpsHubDO',
        'CustomsPreFlightAgent',
        'DispatchCopilotAgent',
        'FleetWatchdogAgent',
        'DocumentProcessingWorkflow',
        'BillingSettlementWorkflow',
      ],
    },
  }),
  site: 'https://brotransport.com',
  base: '/',
  prefetch: true,
  integrations: [
    mdx(),
    react(),
    pwa({
      registerType: 'autoUpdate',
      manifest: {
        name: '#BRO Transport Corp. — Transborder Logistics OS',
        short_name: '#BRO OS',
        description:
          'Bold. Reliable. Orchestrated. North American Cross-Border Dry Van, Reefer, and Flatbed Operations Platform.',
        start_url: '/portal/driver',
        scope: '/',
        theme_color: '#030307',
        background_color: '#030307',
        display: 'standalone',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
          { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,webp,ico,woff2}'],
        globIgnores: ['**/_worker.js/**', '**/_routes.json', '**/_headers'],
        navigateFallback: null,
        runtimeCaching: [
          {
            urlPattern: ({ request }) => request.destination === 'font',
            handler: 'CacheFirst',
            options: {
              cacheName: 'bro-fonts-v1',
              expiration: { maxEntries: 16, maxAgeSeconds: 60 * 60 * 24 * 365 },
            },
          },
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/api/borders/wait-times'),
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'bro-borders-v1',
              expiration: { maxEntries: 8, maxAgeSeconds: 60 * 15 },
            },
          },
        ],
      },
    }),
  ],
  vite: {
    plugins: [tailwind()],
    ssr: {
      external: ['node:crypto', 'node:buffer'],
    },
  },
});
