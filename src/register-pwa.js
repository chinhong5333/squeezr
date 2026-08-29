/**
 * Register the generated root service worker from any HTML entry depth.
 *
 * Resolving relative to this built module (which lives in `assets/`) keeps the
 * registration correct on both a root deployment and a GitHub Pages-style subpath.
 * Development skips registration because Vite does not emit `sw.js` there.
 *
 * @returns {void}
 */
export function registerPwa() {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;

  window.addEventListener('load', () => {
    // Keep this path variable dynamic so Vite leaves URL resolution to the browser.
    const serviceWorkerPath = '../sw.js';
    const serviceWorkerUrl = new URL(serviceWorkerPath, import.meta.url);
    navigator.serviceWorker.register(serviceWorkerUrl).catch((error) => {
      console.error('Service worker registration failed.', error);
    });
  });
}
