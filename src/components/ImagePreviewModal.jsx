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

export default function ImagePreviewModal({
  item,
  initialMode = 'preview',
  onClose,
  onApplyChanges,
  onToggleEnhance,
  onRapikan,
  onResetOriginal,
}) {
  const [mode, setMode] = useState(initialMode);
  const [showOriginal, setShowOriginal] = useState(false);
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
    setShowOriginal(false);
    setMode(initialMode);
    setRapikanNotice('');
  }, [item.id, initialMode]);

  useEffect(() => {
    if (initialMode !== 'crop' || mode !== 'crop') return;
    let cancelled = false;

    (async () => {
      const source = getCropSourceUrl(item);
      const dims = await getImageDimensions(source);
      if (cancelled) return;
      const normalized = normalizeCropRectForSource(
        item.autoCropRect || item.cropRect,
        dims.width,
        dims.height,
      );
      setCropSourceUrl(source);
      setImageSize(dims);
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
  }, [item.cropRect, item.dataUrl, item.enhanceEnabled, item.scanBaseDataUrl, item.autoCropRect, mode]);

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
    setShowOriginal(false);
  };

  const enterCropMode = useCallback(async () => {
    const source = getCropSourceUrl(item);
    const dims = await getImageDimensions(source);
    const normalized = normalizeCropRectForSource(
      autoCropRect || item.cropRect,
      dims.width,
      dims.height,
    );

    setCropSourceUrl(source);
    setImageSize(dims);
    setDraftCropRect(normalized);
    setAutoCropRect(normalized);
    setMode('crop');
  }, [autoCropRect, item]);

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
      }
      applyRapikanResult(result);
      setMode('preview');
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
    try {
      const normalized = normalizeCropRectForSource(
        draftCropRect,
        imageSize.width,
        imageSize.height,
      );
      await onApplyChanges(item.id, {
        cropRect: normalized,
        enhanceEnabled,
      });
      setMode('preview');
      setShowOriginal(false);
    } finally {
      setIsUpdating(false);
    }
  };

  const handleResetCrop = () => {
    const reset = getResetCropRect(item, imageSize.width, imageSize.height);
    setDraftCropRect(reset);
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
              {mode === 'crop' ? 'Sesuaikan Crop' : item.customName || 'Preview Gambar'}
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
            ✕
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
                Tarik sudut crop ke <strong>luar</strong> jika teks masih terpotong. Puas? Tekan{' '}
                <strong>Selesai</strong>. Tidak puas otomatis? <strong>Rapikan Ulang</strong>.
              </p>
              {imageSize.width > 0 ? (
                <CropEditor
                  imageSrc={cropSourceUrl}
                  imageWidth={imageSize.width}
                  imageHeight={imageSize.height}
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
                onClick={enterCropMode}
                disabled={isUpdating}
              >
                Edit Crop
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="btn btn--small btn--secondary"
                onClick={handleApplyCrop}
                disabled={isUpdating || imageSize.width === 0}
              >
                Selesai
              </button>
              <button
                type="button"
                className="btn btn--small btn--outline"
                onClick={handleRapikan}
                disabled={isUpdating}
              >
                Rapikan Ulang
              </button>
              <button type="button" className="btn btn--small btn--outline" onClick={handleResetCrop}>
                Reset Crop Otomatis
              </button>
              <button
                type="button"
                className="btn btn--small btn--outline"
                onClick={handleResetOriginal}
                disabled={isUpdating}
              >
                Kembali ke Asli
              </button>
              <button type="button" className="btn btn--small btn--outline" onClick={() => setMode('preview')}>
                Kembali Preview
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
