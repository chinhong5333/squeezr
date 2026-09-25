import { defineConfig } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import { VitePWA } from 'vite-plugin-pwa';

const projectRoot = dirname(fileURLToPath(import.meta.url));
const contentPageSlugs = [
  'compress-png',
  'compress-jpeg',
  'convert-to-webp',
  'privacy',
  'how-it-works',
];

/**
 * Keep content-page sources grouped under `pages/` without exposing that internal
 * folder in development or production URLs.
 *
 * Source: pages/compress-png.html
 * Public: /compress-png/
 */
function contentPageRoutes() {
  return {
    name: 'squeezr-content-page-routes',
    enforce: 'post',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (!request.url) return next();

        const [pathname, query = ''] = request.url.split('?', 2);
        const slug = contentPageSlugs.find(
          (candidate) => pathname === `/${candidate}` || pathname === `/${candidate}/`
        );

        if (!slug) return next();

        if (pathname === `/${slug}`) {
          response.statusCode = 308;
          response.setHeader('Location', `/${slug}/${query ? `?${query}` : ''}`);
          response.end();
          return;
        }

        request.url = `/pages/${slug}.html${query ? `?${query}` : ''}`;
        next();
      });
    },
    generateBundle(_options, bundle) {
      for (const slug of contentPageSlugs) {
        const sourceFile = `pages/${slug}.html`;
        const publicFile = `${slug}/index.html`;
        const pageAsset = bundle[sourceFile];

        if (!pageAsset || pageAsset.type !== 'asset') {
          throw new Error(`Missing generated content page: ${sourceFile}`);
        }

        delete bundle[sourceFile];
        pageAsset.fileName = publicFile;
        bundle[publicFile] = pageAsset;
      }
    },
  };
}

// The jSquash codecs resolve their .wasm via `new URL('file.wasm', import.meta.url)`,
// which Vite handles natively — but only if they are NOT pre-bundled by esbuild
// (esbuild rewrites import.meta.url and breaks the lookup). Hence optimizeDeps.exclude.
// `imagequant` uses a wasm-bindgen *bundler-target* .wasm ESM import, which needs
// vite-plugin-wasm (+ top-level-await for the generated instantiation).
const codecPackages = [
  '@jsquash/jpeg',
  '@jsquash/oxipng',
  '@jsquash/webp',
  'imagequant',
];

export default defineConfig({
  // Relative base so the built app works from a subpath (GitHub Pages) or file://-style hosts.
  base: './',
  plugins: [
    contentPageRoutes(),
    wasm(),
    topLevelAwait(),
    VitePWA({
      registerType: 'autoUpdate',
      // Multi-page routes cannot use a relative registerSW.js injection. The
      // virtual module in each JS entry registers the single root service worker.
      injectRegister: null,
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'Squeezr',
        short_name: 'Squeezr',
        description: 'Compress PNG & JPEG images in your browser. Files never leave your device.',
        theme_color: '#ffffff',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: './',
        scope: './',
        icons: [
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Precache the whole app shell + every codec .wasm so repeat visits load
        // instantly and the tool works fully offline.
        globPatterns: ['**/*.{js,css,html,svg,wasm,woff2}'],
        navigateFallbackDenylist: [/^\/(?:sitemap\.xml|robots\.txt)(?:\?.*)?$/],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
      },
    }),
  ],
  worker: {
    // ES-module worker: required for the codec dynamic imports + wasm plugins.
    format: 'es',
    plugins: () => [wasm(), topLevelAwait()],
  },
  optimizeDeps: {
    exclude: codecPackages,
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(projectRoot, 'index.html'),
        ...Object.fromEntries(
          contentPageSlugs.map((slug) => [slug, resolve(projectRoot, `pages/${slug}.html`)])
        ),
      },
    },
  },
});
