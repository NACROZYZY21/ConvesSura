import { useEffect, useState } from 'react';
import CropEditor from './CropEditor';
import {
  buildProcessedImage,
  fullCropRect,
  getImageDimensions,
} from '../utils/imageProcessing';

export default function ImagePreviewModal({
  item,
  onClose,
  onApplyChanges,
  onToggleEnhance,
}) {
  const [mode, setMode] = useState('preview');
  const [draftCropRect, setDraftCropRect] = useState(item.cropRect);
  const [previewDataUrl, setPreviewDataUrl] = useState(item.dataUrl);
  const [imageSize, setImageSize] = useState({ width: 0, height: 0 });
  const [isUpdating, setIsUpdating] = useState(false);

  useEffect(() => {
    getImageDimensions(item.originalDataUrl).then(setImageSize);
  }, [item.originalDataUrl]);

  useEffect(() => {
    setDraftCropRect(item.cropRect);
    setPreviewDataUrl(item.dataUrl);
    setMode('preview');
  }, [item.id, item.cropRect, item.dataUrl]);

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

  const refreshPreview = async (cropRect, enhanceEnabled) => {
    setIsUpdating(true);
    try {
      const { dataUrl } = await buildProcessedImage(
        item.originalDataUrl,
        cropRect,
        enhanceEnabled,
      );
      setPreviewDataUrl(dataUrl);
    } finally {
      setIsUpdating(false);
    }
  };

  const handleToggleEnhance = async () => {
    const next = !item.enhanceEnabled;
    await onToggleEnhance(item.id, next);
    await refreshPreview(item.cropRect, next);
  };

  const handleApplyCrop = async () => {
    setIsUpdating(true);
    try {
      await onApplyChanges(item.id, {
        cropRect: draftCropRect,
        enhanceEnabled: item.enhanceEnabled,
      });
      setMode('preview');
    } finally {
      setIsUpdating(false);
    }
  };

  const handleResetCrop = () => {
    if (!imageSize.width || !imageSize.height) return;
    setDraftCropRect(fullCropRect(imageSize.width, imageSize.height));
  };

  const handleBackdropClick = (e) => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    <div className="modal-backdrop" onClick={handleBackdropClick} role="presentation">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="preview-title">
        <div className="modal__header">
          <div>
            <h2 id="preview-title">{item.customName || 'Preview Gambar'}</h2>
            {item.autoCropApplied && mode === 'preview' && (
              <span className="modal__badge">Auto-crop diterapkan</span>
            )}
          </div>
          <button type="button" className="modal__close" onClick={onClose} aria-label="Tutup">
            ✕
          </button>
        </div>

        <div className="modal__body">
          {mode === 'preview' ? (
            <div className={`modal__preview ${isUpdating ? 'modal__preview--loading' : ''}`}>
              <img src={previewDataUrl} alt={item.customName} className="modal__image" />
            </div>
          ) : (
            <CropEditor
              imageSrc={item.originalDataUrl}
              imageWidth={imageSize.width}
              imageHeight={imageSize.height}
              cropRect={draftCropRect}
              onCropChange={setDraftCropRect}
            />
          )}
        </div>

        <div className="modal__toolbar">
          {mode === 'preview' ? (
            <>
              <button
                type="button"
                className={`btn btn--small ${item.enhanceEnabled ? 'btn--filter-active' : 'btn--filter'}`}
                onClick={handleToggleEnhance}
                disabled={isUpdating}
              >
                {item.enhanceEnabled ? '✓ Perjelas Gambar' : 'Perjelas Gambar'}
              </button>
              <button
                type="button"
                className="btn btn--small btn--outline"
                onClick={() => setMode('crop')}
              >
                Edit / Crop
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="btn btn--small btn--secondary"
                onClick={handleApplyCrop}
                disabled={isUpdating}
              >
                Terapkan Crop
              </button>
              <button type="button" className="btn btn--small btn--outline" onClick={handleResetCrop}>
                Reset
              </button>
              <button type="button" className="btn btn--small btn--outline" onClick={() => setMode('preview')}>
                Batal
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
