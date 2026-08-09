/** OpenCV.js embedded lokal — di-load dari /opencv/opencv.js (tanpa CDN/API eksternal). */

let cvPromise = null;
let cvInstance = null;

const INIT_TIMEOUT_MS = 45000;
const OPENCV_SCRIPT = '/opencv/opencv.js';

function waitForRuntime(cv) {
  if (cv?.Mat) return Promise.resolve(cv);
  return Promise.race([
    new Promise((resolve) => {
      cv.onRuntimeInitialized = () => resolve(cv);
    }),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('OpenCV init timeout')), INIT_TIMEOUT_MS);
    }),
  ]);
}

function injectScript() {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-opencv="local"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve(window.cv));
      existing.addEventListener('error', () => reject(new Error('Gagal memuat OpenCV lokal')));
      if (window.cv) resolve(window.cv);
      return;
    }

    const script = document.createElement('script');
    script.src = OPENCV_SCRIPT;
    script.async = true;
    script.dataset.opencv = 'local';
    script.onload = () => resolve(window.cv);
    script.onerror = () => reject(new Error('Gagal memuat OpenCV lokal'));
    document.head.appendChild(script);
  });
}

/** Muat OpenCV sekali; resolve ke instance cv global. */
export function loadOpenCv() {
  if (cvInstance) return Promise.resolve(cvInstance);

  if (!cvPromise) {
    cvPromise = (async () => {
      let cv = window.cv;
      if (!cv) {
        cv = await injectScript();
      }
      cv = await waitForRuntime(cv);
      if (!cv?.Mat) {
        throw new Error('OpenCV failed to initialize');
      }
      cvInstance = cv;
      return cv;
    })().catch((err) => {
      cvPromise = null;
      throw err;
    });
  }

  return cvPromise;
}

/** Preload di background saat app buka — Rapikan langsung siap. */
export function preloadOpenCv() {
  loadOpenCv().catch((err) => {
    console.warn('OpenCV preload:', err.message);
  });
}

export function isOpenCvReady() {
  return cvInstance !== null;
}

export function getOpenCv() {
  return cvInstance;
}
