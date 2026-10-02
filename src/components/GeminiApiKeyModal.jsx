import { useState, useEffect } from 'react';
import {
  getGeminiApiKey,
  setGeminiApiKey,
  removeGeminiApiKey,
  testGeminiApiKey,
} from '../utils/geminiVision';

export default function GeminiApiKeyModal({ isOpen, onClose, onKeySaved }) {
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [savedSuccess, setSavedSuccess] = useState(false);

  useEffect(() => {
    if (isOpen) {
      const current = getGeminiApiKey();
      setApiKey(current || '');
      setTestResult(null);
      setSavedSuccess(false);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const isConfigured = Boolean(apiKey.trim());

  const handleSave = () => {
    setGeminiApiKey(apiKey.trim());
    setSavedSuccess(true);
    setTestResult(null);
    if (onKeySaved) onKeySaved(apiKey.trim());
    setTimeout(() => {
      setSavedSuccess(false);
    }, 2500);
  };

  const handleRemove = () => {
    removeGeminiApiKey();
    setApiKey('');
    setTestResult({ success: true, message: 'API Key berhasil dihapus dari browser.' });
    if (onKeySaved) onKeySaved('');
  };

  const handleTest = async () => {
    if (!apiKey.trim()) {
      setTestResult({ success: false, message: 'Silakan isi API Key terlebih dahulu.' });
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const res = await testGeminiApiKey(apiKey.trim());
      setTestResult(res);
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="gemini-modal-overlay" onClick={onClose}>
      <div className="gemini-modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="gemini-modal-header">
          <div className="gemini-title-wrap">
            <span className="gemini-modal-icon">✨</span>
            <div>
              <h3 className="gemini-modal-title">Pengaturan Gemini AI Scan</h3>
              <p className="gemini-modal-subtitle">
                Gunakan Google AI Studio API Key untuk deteksi 4 sudut scan super presisi & rapi
              </p>
            </div>
          </div>
          <button className="gemini-modal-close" onClick={onClose} title="Tutup">
            ✕
          </button>
        </div>

        <div className="gemini-modal-body">
          <div className="gemini-status-row">
            <span className="gemini-status-label">Status AI:</span>
            {isConfigured ? (
              <span className="gemini-badge gemini-badge-active">
                ● Aktif (Siap Deteksi Presisi)
              </span>
            ) : (
              <span className="gemini-badge gemini-badge-inactive">
                ○ Belum Terpasang (Memakai OpenCV biasa)
              </span>
            )}
          </div>

          <div className="gemini-input-group">
            <label className="gemini-label">Google AI Studio API Key:</label>
            <div className="gemini-input-wrapper">
              <input
                type={showKey ? 'text' : 'password'}
                className="gemini-input"
                placeholder="AIzaSy..."
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
              <button
                type="button"
                className="gemini-btn-icon"
                onClick={() => setShowKey(!showKey)}
                title={showKey ? 'Sembunyikan' : 'Tampilkan'}
              >
                {showKey ? '🙈' : '👁️'}
              </button>
            </div>
          </div>

          <div className="gemini-info-box">
            <p>
              💡 <strong>Gratis 100%</strong>: Dapatkan API Key gratis di{' '}
              <a
                href="https://aistudio.google.com/app/apikey"
                target="_blank"
                rel="noreferrer"
                className="gemini-link"
              >
                Google AI Studio ↗
              </a>{' '}
              (Bisa scan s/d 1.500 dokumen gratis setiap hari).
            </p>
            <p className="gemini-info-sub">
              Key ini disimpan langsung di browser lokal Anda (localStorage) atau dapat ditaruh di file{' '}
              <code>.env.local</code> dengan nama <code>VITE_GEMINI_API_KEY</code>.
            </p>
          </div>

          {testResult && (
            <div
              className={`gemini-alert ${testResult.success ? 'gemini-alert-success' : 'gemini-alert-error'}`}
            >
              {testResult.success ? '✅ ' : '⚠️ '}
              {testResult.message}
            </div>
          )}

          {savedSuccess && (
            <div className="gemini-alert gemini-alert-success">
              ✅ API Key berhasil disimpan! Fitur Rapikan dengan AI sekarang aktif.
            </div>
          )}
        </div>

        <div className="gemini-modal-footer">
          {isConfigured && (
            <button
              type="button"
              className="gemini-btn-danger"
              onClick={handleRemove}
              disabled={testing}
            >
              Hapus Key
            </button>
          )}

          <div className="gemini-footer-actions">
            <button
              type="button"
              className="gemini-btn-secondary"
              onClick={handleTest}
              disabled={testing || !apiKey.trim()}
            >
              {testing ? 'Menguji...' : '🔍 Tes Koneksi'}
            </button>

            <button
              type="button"
              className="gemini-btn-primary"
              onClick={handleSave}
              disabled={testing}
            >
              💾 Simpan
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
