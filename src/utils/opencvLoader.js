/** OpenCV.js loader — handles Promise resolution and runtime initialization */

let cvPromise = null;
let cvInstance = null;

const INIT_TIMEOUT_MS = 30000;
const OPENCV_SCRIPT = '/opencv/opencv.js';

async function resolveCv(rawCv) {
  if (!rawCv) return null;

  // 1. If rawCv is a Promise or Thenable (as in @techstark/opencv-js)
  if (typeof rawCv.then === 'function') {
    try {
      const resolved = await rawCv;
      if (resolved && (resolved.Mat || resolved.cvtColor)) {
        return resolved;
      }
      rawCv = resolved || rawCv;
    } catch (e) {
      console.warn('Error awaiting cv promise:', e);
    }
  }

  // 2. If cv.Mat already exists directly
  if (rawCv && (rawCv.Mat || rawCv.cvtColor)) {
    return rawCv;
  }

  // 3. If window.cv is resolved separately
  if (window.cv && window.cv !== rawCv) {
    if (typeof window.cv.then === 'function') {
      const resolved = await window.cv;
      if (resolved && (resolved.Mat || resolved.cvtColor)) return resolved;
    } else if (window.cv.Mat || window.cv.cvtColor) {
      return window.cv;
    }
  }

  // 4. Wait for onRuntimeInitialized or polling fallback
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      const check = window.cv || rawCv;
      if (check && (check.Mat || check.cvtColor)) {
        resolve(check);
      } else {
        reject(new Error('OpenCV initialization timeout'));
      }
    }, INIT_TIMEOUT_MS);

    const target = rawCv || window.cv || {};
    const prevInit = target.onRuntimeInitialized;

    target.onRuntimeInitialized = () => {
      if (typeof prevInit === 'function') prevInit();
      clearTimeout(timeout);
      resolve(window.cv || target);
    };

    const interval = setInterval(() => {
      const check = window.cv || target;
      if (check && (check.Mat || check.cvtColor)) {
        clearTimeout(timeout);
        clearInterval(interval);
        resolve(check);
      }
    }, 100);
  });
}

function injectScript() {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-opencv="local"]`);
    if (existing) {
      if (window.cv) return resolve(window.cv);
      existing.addEventListener('load', () => resolve(window.cv));
      existing.addEventListener('error', () => reject(new Error('Gagal memuat OpenCV lokal')));
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

/** Muat OpenCV sekali; resolve ke instance cv global yang siap pakai. */
export function loadOpenCv() {
  if (cvInstance) return Promise.resolve(cvInstance);

  if (!cvPromise) {
    cvPromise = (async () => {
      let raw = window.cv;
      if (!raw) {
        raw = await injectScript();
      }
      const instance = await resolveCv(raw || window.cv);
      if (!instance || (!instance.Mat && !instance.cvtColor)) {
        throw new Error('OpenCV failed to initialize');
      }
      cvInstance = instance;
      return instance;
    })().catch((err) => {
      cvPromise = null;
      throw err;
    });
  }

  return cvPromise;
}

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
