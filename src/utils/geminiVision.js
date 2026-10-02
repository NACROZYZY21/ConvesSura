import { orderCorners } from './documentScan.js';

const STORAGE_KEY = 'gemini_api_key';

/**
 * Mendapatkan Gemini API Key dari localStorage atau environment variable.
 */
export function getGeminiApiKey() {
  if (typeof window !== 'undefined') {
    const local = localStorage.getItem(STORAGE_KEY);
    if (local && local.trim()) return local.trim();
  }
  return (import.meta.env.VITE_GEMINI_API_KEY || '').trim();
}

/**
 * Menyimpan Gemini API Key ke localStorage.
 */
export function setGeminiApiKey(key) {
  if (typeof window === 'undefined') return;
  if (!key || !key.trim()) {
    localStorage.removeItem(STORAGE_KEY);
  } else {
    localStorage.setItem(STORAGE_KEY, key.trim());
  }
}

/**
 * Menghapus Gemini API Key dari localStorage.
 */
export function removeGeminiApiKey() {
  if (typeof window !== 'undefined') {
    localStorage.removeItem(STORAGE_KEY);
  }
}

/**
 * Memeriksa apakah Gemini API Key sudah terpasang.
 */
export function hasGeminiApiKey() {
  return Boolean(getGeminiApiKey());
}

/**
 * Mengecilkan gambar sebelum dikirim ke Gemini Vision
 * agar hemat token, upload super cepat, dan tidak boros kuota.
 */
export async function prepareImageForGemini(dataUrl, maxDimension = 1024) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const origWidth = img.naturalWidth;
      const origHeight = img.naturalHeight;
      const maxSide = Math.max(origWidth, origHeight);
      const scale = Math.min(1, maxDimension / maxSide);

      const targetW = Math.max(1, Math.round(origWidth * scale));
      const targetH = Math.max(1, Math.round(origHeight * scale));

      const canvas = document.createElement('canvas');
      canvas.width = targetW;
      canvas.height = targetH;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, targetW, targetH);

      const jpegUrl = canvas.toDataURL('image/jpeg', 0.85);
      const base64Data = jpegUrl.replace(/^data:image\/[a-z]+;base64,/, '');

      resolve({
        base64: base64Data,
        mimeType: 'image/jpeg',
        origWidth,
        origHeight,
        scaledWidth: targetW,
        scaledHeight: targetH,
      });
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}

export const CANDIDATE_GEMINI_MODELS = [
  'gemini-3.8-flash',
  'gemini-2.5-flash',
  'gemini-1.5-flash',
  'gemini-2.0-flash',
];

function extractSuggestedModel(errorMessage) {
  if (!errorMessage || typeof errorMessage !== 'string') return null;
  const match =
    errorMessage.match(/models\/([a-zA-Z0-9.-]+)\s+for the latest/i) ||
    errorMessage.match(/use\s+(?:models\/)?([a-zA-Z0-9.-]+)/i);
  return match ? match[1] : null;
}

/**
 * Uji coba API Key apakah valid dan bisa digunakan.
 */
export async function testGeminiApiKey(apiKey = null) {
  const key = apiKey || getGeminiApiKey();
  if (!key) {
    return { success: false, message: 'API Key belum diisi.' };
  }

  const modelsToTry = [...CANDIDATE_GEMINI_MODELS];
  let lastErrMsg = '';

  for (let i = 0; i < modelsToTry.length; i++) {
    const model = modelsToTry[i];
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: 'Test connection. Reply with {"status":"ok"}' }] }],
          generationConfig: { response_mime_type: 'application/json' },
        }),
      });

      if (res.ok) {
        return { success: true, message: `API Key valid & terhubung dengan ${model}!` };
      }

      const errorJson = await res.json().catch(() => ({}));
      lastErrMsg = errorJson?.error?.message || `HTTP ${res.status} ${res.statusText}`;

      const suggested = extractSuggestedModel(lastErrMsg);
      if (suggested && !modelsToTry.includes(suggested)) {
        modelsToTry.push(suggested);
      }

      if (res.status === 400 && lastErrMsg.toLowerCase().includes('api key not valid')) {
        return { success: false, message: 'API Key tidak valid. Periksa kembali API Key dari Google AI Studio.' };
      }
    } catch (err) {
      lastErrMsg = err.message || 'Gagal menghubungi server Google Gemini.';
    }
  }

  return { success: false, message: lastErrMsg };
}

function parsePoint(p, origWidth, origHeight) {
  if (!p) return null;
  let x = 0;
  let y = 0;

  if (Array.isArray(p)) {
    x = Number(p[0]);
    y = Number(p[1]);
  } else if (typeof p === 'object') {
    x = Number(p.x ?? p.left ?? p[0] ?? 0);
    y = Number(p.y ?? p.top ?? p[1] ?? 0);
  }

  if (isNaN(x) || isNaN(y)) return null;

  // Jika nilai berada dalam rentang 0-1000
  if (x > 1.5 || y > 1.5) {
    x = (x / 1000) * origWidth;
    y = (y / 1000) * origHeight;
  } else {
    // Jika berupa normalisasi 0.0 - 1.0
    x = x * origWidth;
    y = y * origHeight;
  }

  return {
    x: Math.max(0, Math.min(origWidth, Math.round(x))),
    y: Math.max(0, Math.min(origHeight, Math.round(y))),
  };
}

/**
 * Deteksi 4 sudut fisik dokumen menggunakan Gemini Vision AI.
 * Mengembalikan koordinat 4 sudut [tl, tr, br, bl] dan rotasi yang disarankan.
 */
export async function detectDocumentCornersWithGemini(originalDataUrl, apiKeyOverride = null) {
  const apiKey = apiKeyOverride || getGeminiApiKey();
  if (!apiKey) {
    throw new Error('Gemini API Key belum dimasukkan. Silakan pasang API Key di menu ✨ Gemini AI.');
  }

  const { base64, mimeType, origWidth, origHeight } = await prepareImageForGemini(
    originalDataUrl,
    1024,
  );

  const prompt = `You are an expert document scanner.
Identify the EXACT 4 physical corners of the paper document, receipt, or card in this image:
- top_left: top-left corner of the document
- top_right: top-right corner of the document
- bottom_right: bottom-right corner of the document
- bottom_left: bottom-left corner of the document

Ignore surrounding background surfaces like desks, tablecloths, floors, hands, and shadows.
Return coordinates normalized to a 0-1000 integer range where (0,0) is top-left and (1000,1000) is bottom-right.
If the text on the document is upside-down or sideways, specify rotation_degrees (0, 90, 180, or 270 clockwise) to make it right-side up.`;

  // Coba model gemini-3.8-flash terlebih dahulu, fallback ke model lainnya
  const models = [...CANDIDATE_GEMINI_MODELS];
  let lastError = null;

  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    try {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  inline_data: {
                    mime_type: mimeType,
                    data: base64,
                  },
                },
                { text: prompt },
              ],
            },
          ],
          generationConfig: {
            response_mime_type: 'application/json',
            response_schema: {
              type: 'OBJECT',
              properties: {
                top_left: {
                  type: 'OBJECT',
                  properties: {
                    x: { type: 'NUMBER' },
                    y: { type: 'NUMBER' },
                  },
                  required: ['x', 'y'],
                },
                top_right: {
                  type: 'OBJECT',
                  properties: {
                    x: { type: 'NUMBER' },
                    y: { type: 'NUMBER' },
                  },
                  required: ['x', 'y'],
                },
                bottom_right: {
                  type: 'OBJECT',
                  properties: {
                    x: { type: 'NUMBER' },
                    y: { type: 'NUMBER' },
                  },
                  required: ['x', 'y'],
                },
                bottom_left: {
                  type: 'OBJECT',
                  properties: {
                    x: { type: 'NUMBER' },
                    y: { type: 'NUMBER' },
                  },
                  required: ['x', 'y'],
                },
                rotation_degrees: {
                  type: 'INTEGER',
                  description: 'Rotation clockwise needed to orient text upright: 0, 90, 180, 270',
                },
              },
              required: ['top_left', 'top_right', 'bottom_right', 'bottom_left'],
            },
            temperature: 0.1,
          },
        }),
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        const errMsg = errJson?.error?.message || `HTTP ${res.status}`;
        const suggested = extractSuggestedModel(errMsg);
        if (suggested && !models.includes(suggested)) {
          models.push(suggested);
        }
        throw new Error(errMsg);
      }

      const data = await res.json();
      const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!rawText) throw new Error('Format respon Gemini kosong.');

      let parsed;
      try {
        parsed = JSON.parse(rawText);
      } catch {
        const cleaned = rawText.replace(/```json\s*|\s*```/g, '').trim();
        parsed = JSON.parse(cleaned);
      }

      const cornersObj = parsed.corners || parsed;
      const tl = parsePoint(cornersObj.top_left || cornersObj.topLeft, origWidth, origHeight);
      const tr = parsePoint(cornersObj.top_right || cornersObj.topRight, origWidth, origHeight);
      const br = parsePoint(
        cornersObj.bottom_right || cornersObj.bottomRight,
        origWidth,
        origHeight,
      );
      const bl = parsePoint(cornersObj.bottom_left || cornersObj.bottomLeft, origWidth, origHeight);

      if (!tl || !tr || !br || !bl) {
        throw new Error('Gagal mengekstrak 4 sudut dokumen dari respon AI.');
      }

      const corners = orderCorners([tl, tr, br, bl]);
      const rotation = Number(
        parsed.rotation_degrees ?? parsed.rotation ?? parsed.rotation_needed ?? 0,
      );

      return {
        corners,
        rotation,
        confidence: Number(parsed.confidence ?? 0.95),
        model,
      };
    } catch (err) {
      lastError = err;
      console.warn(`Gagal dengan model ${model}:`, err.message);
      // Lanjut ke model berikutnya jika ada
    }
  }

  throw lastError || new Error('Gagal mendeteksi sudut dokumen dengan Gemini Vision.');
}
