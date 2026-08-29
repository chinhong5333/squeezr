import '@fontsource-variable/inter';
import './style.css';

// Keep static content pages in sync after a service-worker update, matching the
// compressor entry without loading the compression worker or JSZip.
if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing || !hadController) return;
    refreshing = true;
    window.location.reload();
  });
}

const THEME_KEY = 'squeezr-theme';
const themeBtn = document.querySelector('#theme-btn');
const themeIsDark = () => document.documentElement.dataset.theme === 'dark';

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch (_) {
    // Storage may be disabled; the selected theme still applies for this page.
  }
  themeBtn?.setAttribute(
    'aria-label',
    theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'
  );
}

if (themeBtn) {
  themeBtn.setAttribute(
    'aria-label',
    themeIsDark() ? 'Switch to light theme' : 'Switch to dark theme'
  );
  themeBtn.addEventListener('click', () => applyTheme(themeIsDark() ? 'light' : 'dark'));
}

// Preserve the existing background behavior without adding page-load or scroll motion.
if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
  const root = document.documentElement;
  let pointerX = 0;
  let pointerY = 0;
  let queued = false;

  window.addEventListener(
    'pointermove',
    (event) => {
      pointerX = event.clientX;
      pointerY = event.clientY;
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        root.style.setProperty('--cx', `${pointerX}px`);
        root.style.setProperty('--cy', `${pointerY}px`);
      });
    },
    { passive: true }
  );
}
