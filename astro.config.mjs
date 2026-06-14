import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import tailwind from '@tailwindcss/vite';
import react from '@astrojs/react';
import keystatic from '@keystatic/astro';
import pwa from '@vite-pwa/astro';

const isProdBuild = process.env.NODE_ENV === 'production' || process.env.SKIP_KEYSTATIC === 'true';

const integrations = [
  mdx(),
  react(),
  // Load Keystatic only in development to prevent SSR adapter requirements on static Pages builds
  !isProdBuild ? keystatic() : null,
  pwa({
    registerType: 'autoUpdate',
    manifest: {
      name: '#BRO Transport Corp. | Elite Logistics',
      short_name: '#BRO',
      theme_color: '#0B0F19',
      background_color: '#0B0F19',
      display: 'standalone',
      icons: [
        { src: '/favicon.svg', sizes: '192x192', type: 'image/svg+xml' }
      ]
    },
    workbox: {
      globPatterns: ['**/*.{js,css,html,svg,ico,woff2}'],
      runtimeCaching: [
        {
          urlPattern: ({ request }) => request.destination === 'font',
          handler: 'CacheFirst',
          options: {
            cacheName: 'fonts-cache',
            expiration: { maxEntries: 10 }
          }
        }
      ]
    }
  })
].filter(Boolean);

// https://astro.build/config
export default defineConfig({
  integrations,
  prefetch: true,
  vite: {
    plugins: [tailwind()],
  }
});
