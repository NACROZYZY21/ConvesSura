import { useCallback, useEffect, useState } from 'react';
import CropEditor from './CropEditor';
import {
  buildProcessedImage,
  getCropSourceUrl,
  getResetCropRect,
  getImageDimensions,
  isRapikanDone,
  normalizeCropRectForSource,
} from '../utils/imageProcessing';

function getDefaultCorners(width, height) {
  const mx = Math.max(10, Math.round(width * 0.08));
  const my = Math.max(10, Math.round(height * 0.08));
  return [
    { x: mx, y: my },
    { x: width - mx, y: my },
    { x: width - mx, y: height - my },
    { x: mx, y: height - my },
  ];
}

export default function ImagePreviewModal({
  item,
  initialMode = 'preview',
  onClose,
  onApplyChanges,
  onApplyCorners,
  onToggleEnhance,
  onRapikan,
  onRotate,
  onResetOriginal,
}) {
  const [mode, setMode] = useState(initialMode);
  const [cropType, setCropType] = useState('perspective'); // 'perspective' (4 sudut) | 'box' (kotak)
  const [showOriginal, setShowOriginal] = useState(false);
  const [draftCorners, setDraftCorners] = useState(item.detectedCorners || null);
  const [draftCropRect, setDraftCropRect] = useState(item.cropRect);
  const [previewDataUrl, setPreviewDataUrl] = useState(item.dataUrl);
  const [enhanceEnabled, setEnhanceEnabled] = useState(item.enhanceEnabled ?? false);
  const [cropSourceUrl, setCropSourceUrl] = useState(getCropSourceUrl(item));
  const [autoCropRect, setAutoCropRect] = useState(item.autoCropRect || item.cropRect);
  const [imageSize, setImageSize] = useState({ width: 0, height: 0 });
  const [isUpdating, setIsUpdating] = useState(false);
  const [rapikanNotice, setRapikanNotice] = useState('');

  useEffect(() => {
    getImageDimensions(cropSourceUrl).then(setImageSize);
  }, [cropSourceUrl]);

  useEffect(() => {
    setDraftCropRect(item.cropRect);
    setPreviewDataUrl(item.dataUrl);
    setEnhanceEnabled(item.enhanceEnabled ?? false);
    setCropSourceUrl(getCropSourceUrl(item));
    setAutoCropRect(item.autoCropRect || item.cropRect);
    setDraftCorners(item.detectedCorners || null);
    setShowOriginal(false);
    setMode(initialMode);
    setRapikanNotice('');
  }, [item.id, initialMode]);

  useEffect(() => {
    if (initialMode !== 'crop' || mode !== 'crop') return;
    let cancelled = false;

    (async () => {
      const source = item.originalDataUrl || getCropSourceUrl(item);
      const dims = await getImageDimensions(source);
      if (cancelled) return;

      const corners =
        item.detectedCorners && item.detectedCorners.length === 4
          ? item.detectedCorners
          : getDefaultCorners(dims.width, dims.height);

      const normalized = normalizeCropRectForSource(
        item.autoCropRect || item.cropRect,
        dims.width,
        dims.height,
      );

      setCropSourceUrl(source);
      setImageSize(dims);
      setCropType('perspective');
      setDraftCorners(corners);
      setDraftCropRect(normalized);
      setAutoCropRect(normalized);
    })();

    return () => {
      cancelled = true;
    };
  }, [item.id, initialMode, mode, item]);

  useEffect(() => {
    if (mode === 'crop') return;
    setDraftCropRect(item.cropRect);
    setPreviewDataUrl(item.dataUrl);
    setEnhanceEnabled(item.enhanceEnabled ?? false);
    setCropSourceUrl(getCropSourceUrl(item));
    setAutoCropRect(item.autoCropRect || item.cropRect);
    setDraftCorners(item.detectedCorners || null);
  }, [item.cropRect, item.dataUrl, item.enhanceEnabled, item.scanBaseDataUrl, item.autoCropRect, item.detectedCorners, mode]);

  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
    };
  }, []);

  const applyRapikanResult = (result) => {
    if (!result?.cropRect) return;
    setDraftCropRect(result.cropRect);
    setPreviewDataUrl(result.dataUrl);
    if (result.autoCropRect) setAutoCropRect(result.autoCropRect);
    if (result.scanBaseDataUrl) setCropSourceUrl(result.scanBaseDataUrl);
    if (result.detectedCorners) setDraftCorners(result.detectedCorners);
    setShowOriginal(false);
  };

  const enterCropMode = useCallback(
    async (targetCropType = 'perspective') => {
      // Untuk mode 4 sudut, selalu gunakan foto asli agar seluruh meja & tepi kertas terlihat
      const source =
        targetCropType === 'perspective'
          ? item.originalDataUrl || getCropSourceUrl(item)
          : getCropSourceUrl(item);

      const dims = await getImageDimensions(source);

      const corners =
        item.detectedCorners && item.detectedCorners.length === 4
          ? item.detectedCorners
          : getDefaultCorners(dims.width, dims.height);

      const normalized = normalizeCropRectForSource(
        autoCropRect || item.cropRect,
        dims.width,
        dims.height,
      );

      setCropSourceUrl(source);
      setImageSize(dims);
      setCropType(targetCropType);
      setDraftCorners(corners);
      setDraftCropRect(normalized);
      setAutoCropRect(normalized);
      setMode('crop');
    },
    [autoCropRect, item],
  );

  const handleRapikan = async () => {
    if (isUpdating || !onRapikan) return;

    setIsUpdating(true);
    setRapikanNotice('');
    try {
      const result = await onRapikan(item.id);
      if (!result?.cropRect) {
        setRapikanNotice(
          result?.error
            ? `Gagal merapikan: ${result.error}`
            : 'Tepi kertas tidak terdeteksi. Coba Edit Crop manual.',
        );
        return;
      }
      if (result.rapikanFailed) {
        setRapikanNotice('Tepi kertas tidak terdeteksi otomatis. Gunakan Edit Crop manual.');
      } else if (result.usedGeminiAi) {
        setRapikanNotice('✨ Dokumen berhasil diluruskan presisi tinggi dengan Gemini AI!');
      } else if (result.geminiError) {
        setRapikanNotice(`⚠️ Gemini AI: ${result.geminiError}`);
      }
      applyRapikanResult(result);
      setMode('preview');
    } finally {
      setIsUpdating(false);
    }
  };

  const handleRotate = async () => {
    if (isUpdating || !onRotate) return;
    setIsUpdating(true);
    setRapikanNotice('');
    try {
      const result = await onRotate(item.id, 90);
      if (result) {
        setPreviewDataUrl(result.dataUrl);
        setCropSourceUrl(result.scanBaseDataUrl || result.originalDataUrl);
        if (result.cropRect) setDraftCropRect(result.cropRect);
        if (result.autoCropRect) setAutoCropRect(result.autoCropRect);
      }
    } finally {
      setIsUpdating(false);
    }
  };

  const handleResetOriginal = async () => {
    if (isUpdating || !onResetOriginal) return;

    setIsUpdating(true);
    try {
      const result = await onResetOriginal(item.id);
      if (result?.cropRect) {
        setDraftCropRect(result.cropRect);
        setAutoCropRect(result.autoCropRect || result.cropRect);
        setPreviewDataUrl(result.dataUrl);
        if (result.scanBaseDataUrl) setCropSourceUrl(result.scanBaseDataUrl);
        setShowOriginal(false);
        setMode('preview');
      }
    } finally {
      setIsUpdating(false);
    }
  };

  const handleToggleEnhance = async () => {
    if (isUpdating) return;

    const next = !enhanceEnabled;
    setIsUpdating(true);

    try {
      const result = await onToggleEnhance(item.id, next);
      if (result?.dataUrl) {
        setPreviewDataUrl(result.dataUrl);
        setEnhanceEnabled(result.enhanceEnabled ?? next);
      } else {
        const { dataUrl } = await buildProcessedImage(item, item.cropRect, next);
        setPreviewDataUrl(dataUrl);
        setEnhanceEnabled(next);
      }
      setShowOriginal(false);
    } finally {
      setIsUpdating(false);
    }
  };

  const handleApplyCrop = async () => {
    setIsUpdating(true);
    setRapikanNotice('');
    try {
      // JIKA DALAM MODE 4 SUDUT BEBAS (PERSPECTIVE):
      if (cropType === 'perspective' && draftCorners && draftCorners.length === 4) {
        if (onApplyCorners) {
          const res = await onApplyCorners(item.id, {
            corners: draftCorners,
            enhanceEnabled,
          });
          if (res) {
            applyRapikanResult(res);
            setRapikanNotice('✨ Dokumen berhasil diluruskan sesuai 4 sudut pilihan Anda!');
          }
        }
      } else {
        // JIKA DALAM MODE KOTAK STANDAR:
        const normalized = normalizeCropRectForSource(
          draftCropRect,
          imageSize.width,
          imageSize.height,
        );
        await onApplyChanges(item.id, {
          cropRect: normalized,
          enhanceEnabled,
        });
      }
      setMode('preview');
      setShowOriginal(false);
    } catch (err) {
      console.error('Apply crop error:', err);
      setRapikanNotice(`Gagal menerapkan crop: ${err.message}`);
    } finally {
      setIsUpdating(false);
    }
  };

  const handleResetCrop = () => {
    const reset = getResetCropRect(item, imageSize.width, imageSize.height);
    setDraftCropRect(reset);
  };

  const handleSetFullCorners = () => {
    if (imageSize.width && imageSize.height) {
      setDraftCorners([
        { x: 0, y: 0 },
        { x: imageSize.width, y: 0 },
        { x: imageSize.width, y: imageSize.height },
        { x: 0, y: imageSize.height },
      ]);
    }
  };

  const handleResetToAiCorners = () => {
    if (item.detectedCorners && item.detectedCorners.length === 4) {
      setDraftCorners(item.detectedCorners);
    } else if (imageSize.width && imageSize.height) {
      setDraftCorners(getDefaultCorners(imageSize.width, imageSize.height));
    }
  };

  const handleBackdropClick = (e) => {
    if (e.target === e.currentTarget) onClose();
  };

  const isRapikanDoneFlag = isRapikanDone(item);
  const canCompare = isRapikanDoneFlag && item.originalDataUrl;
  const previewSrc =
    showOriginal && canCompare ? item.originalDataUrl : item.dataUrl || previewDataUrl;

  return (
    <div className="modal-backdrop" onClick={handleBackdropClick} role="presentation">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="preview-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal__header">
          <div>
            <h2 id="preview-title">
              {mode === 'crop' ? 'Sesuaikan Sudut Crop' : item.customName || 'Preview Gambar'}
            </h2>
            <div className="modal__badges">
              {isRapikanDoneFlag && mode === 'preview' && (
                <span className="modal__badge">Rapikan</span>
              )}
              {enhanceEnabled && mode === 'preview' && (
                <span className="modal__badge modal__badge--enhance">Perjelas</span>
              )}
            </div>
          </div>
          <button type="button" className="modal__close" onClick={onClose} aria-label="Tutup">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
          </button>
        </div>

        <div className="modal__body">
          {rapikanNotice && mode === 'preview' && (
            <p className="modal__notice" role="status">
              {rapikanNotice}
            </p>
          )}
          {mode === 'preview' ? (
            <div className={`modal__preview ${isUpdating ? 'modal__preview--loading' : ''}`}>
              {canCompare && (
                <div className="modal__compare" role="tablist" aria-label="Bandingkan gambar">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={!showOriginal}
                    className={`modal__compare-btn ${!showOriginal ? 'modal__compare-btn--active' : ''}`}
                    onClick={() => setShowOriginal(false)}
                  >
                    Hasil
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={showOriginal}
                    className={`modal__compare-btn ${showOriginal ? 'modal__compare-btn--active' : ''}`}
                    onClick={() => setShowOriginal(true)}
                  >
                    Asli
                  </button>
                </div>
              )}
              {isUpdating && (
                <p className="modal__processing" role="status">
                  Merapikan dokumen...
                </p>
              )}
              <img src={previewSrc} alt={item.customName} className="modal__image" />
            </div>
          ) : (
            <div className="modal__crop-panel">
              <p className="modal__crop-hint">
                {cropType === 'perspective' ? (
                  <>
                    💡 Tarik <strong>1 per 1 titik lingkaran</strong> ke sudut fisik kertas/struk.
                    Kaca pembesar akan otomatis muncul saat Anda menggeser titik!
                  </>
                ) : (
                  <>
                    Tarik sudut kotak crop. Tekan <strong>Selesai</strong> setelah selesai.
                  </>
                )}
              </p>
              {imageSize.width > 0 ? (
                <CropEditor
                  imageSrc={cropSourceUrl}
                  imageWidth={imageSize.width}
                  imageHeight={imageSize.height}
                  cropType={cropType}
                  onCropTypeChange={setCropType}
                  corners={draftCorners}
                  onCornersChange={setDraftCorners}
                  cropRect={draftCropRect}
                  onCropChange={setDraftCropRect}
                />
              ) : (
                <p className="modal__crop-loading">Memuat editor crop...</p>
              )}
            </div>
          )}
        </div>

        <div className="modal__toolbar">
          {mode === 'preview' ? (
            <>
              <button
                type="button"
                className="btn btn--small btn--outline"
                onClick={handleRapikan}
                disabled={isUpdating}
              >
                {isUpdating ? 'Memproses...' : isRapikanDoneFlag ? 'Rapikan Ulang' : 'Rapikan'}
              </button>
              <button
                type="button"
                className={`btn btn--small ${enhanceEnabled ? 'btn--filter-active' : 'btn--filter'}`}
                onClick={handleToggleEnhance}
                disabled={isUpdating}
              >
                {isUpdating
                  ? 'Memproses...'
                  : enhanceEnabled
                    ? '✓ Perjelas Gambar'
                    : 'Perjelas Gambar'}
              </button>
              <button
                type="button"
                className="btn btn--small btn--outline"
                onClick={() => enterCropMode('perspective')}
                disabled={isUpdating}
                title="Sesuaikan 4 sudut dokumen secara bebas"
              >
                📐 Edit Sudut
              </button>
              <button
                type="button"
                className="btn btn--small btn--outline"
                onClick={handleRotate}
                disabled={isUpdating}
                title="Putar 90 derajat searah jarum jam"
              >
                🔄 Putar 90°
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="btn btn--small btn--primary"
                onClick={handleApplyCrop}
                disabled={isUpdating || imageSize.width === 0}
              >
                ✓ Selesai
              </button>
              {cropType === 'perspective' && (
                <>
                  <button
                    type="button"
                    className="btn btn--small btn--outline"
                    onClick={handleSetFullCorners}
                    title="Pilih seluruh area foto"
                  >
                    Seluruh Foto
                  </button>
                  {item.detectedCorners && (
                    <button
                      type="button"
                      className="btn btn--small btn--outline"
                      onClick={handleResetToAiCorners}
                      title="Kembalikan ke sudut deteksi AI"
                    >
                      Reset Sudut AI
                    </button>
                  )}
                </>
              )}
              {cropType === 'box' && (
                <button
                  type="button"
                  className="btn btn--small btn--outline"
                  onClick={handleResetCrop}
                >
                  Reset Kotak
                </button>
              )}
              <button
                type="button"
                className="btn btn--small btn--outline"
                onClick={handleResetOriginal}
                disabled={isUpdating}
              >
                Kembali ke Asli
              </button>
              <button
                type="button"
                className="btn btn--small btn--outline"
                onClick={() => setMode('preview')}
              >
                Batal
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
