import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import { VitePWA } from 'vite-plugin-pwa';

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
    wasm(),
    topLevelAwait(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
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
});
