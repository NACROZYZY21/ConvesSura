import { useCallback, useRef, useState } from 'react';
import ImagePreviewModal from './components/ImagePreviewModal';
import {
  convertMergedImages,
  convertSingleImage,
  downloadAllSequentially,
  downloadBlob,
  fileToDataUrl,
  stripExtension,
} from './utils/pdfConverter';
import { buildProcessedImage, processUploadedImage } from './utils/imageProcessing';
import './App.css';

function createId() {
  return crypto.randomUUID();
}

function App() {
  const [images, setImages] = useState([]);
  const [mode, setMode] = useState('separate');
  const [mergedName, setMergedName] = useState('gabungan');
  const [mergedBlob, setMergedBlob] = useState(null);
  const [isConverting, setIsConverting] = useState(false);
  const [isProcessingUpload, setIsProcessingUpload] = useState(false);
  const [progress, setProgress] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [dragIndex, setDragIndex] = useState(null);
  const [previewId, setPreviewId] = useState(null);
  const fileInputRef = useRef(null);
  const imagesRef = useRef(images);
  imagesRef.current = images;

  const addFiles = useCallback(async (fileList) => {
    const accepted = Array.from(fileList).filter((file) =>
      ['image/png', 'image/jpeg', 'image/jpg'].includes(file.type),
    );

    if (accepted.length === 0) return;

    setIsProcessingUpload(true);
    setProgress('Memproses gambar & auto-crop...');

    try {
      const newItems = await Promise.all(
        accepted.map(async (file) => {
          const originalDataUrl = await fileToDataUrl(file);
          const processed = await processUploadedImage(file, originalDataUrl);

          return {
            id: createId(),
            file,
            customName: stripExtension(file.name),
            pdfBlob: null,
            ...processed,
          };
        }),
      );

      setImages((prev) => [...prev, ...newItems]);
      setMergedBlob(null);
    } finally {
      setIsProcessingUpload(false);
      setProgress('');
    }
  }, []);

  const updateImageProcessing = useCallback(async (id, patch) => {
    const current = imagesRef.current.find((img) => img.id === id);
    if (!current) return;

    const cropRect = patch.cropRect ?? current.cropRect;
    const enhanceEnabled = patch.enhanceEnabled ?? current.enhanceEnabled;
    const autoCropApplied =
      patch.autoCropApplied !== undefined ? patch.autoCropApplied : current.autoCropApplied;

    const { dataUrl } = await buildProcessedImage(
      current.originalDataUrl,
      cropRect,
      enhanceEnabled,
    );

    setImages((prev) =>
      prev.map((img) =>
        img.id === id
          ? {
              ...img,
              cropRect,
              enhanceEnabled,
              autoCropApplied,
              dataUrl,
              pdfBlob: null,
            }
          : { ...img, pdfBlob: null },
      ),
    );
    setMergedBlob(null);
  }, []);

  const applyImageChanges = useCallback(
    async (id, { cropRect, enhanceEnabled }) => {
      await updateImageProcessing(id, {
        cropRect,
        enhanceEnabled,
        autoCropApplied: false,
      });
    },
    [updateImageProcessing],
  );

  const handleToggleEnhance = useCallback(
    async (id, enabled) => {
      const item = images.find((img) => img.id === id);
      if (!item) return;

      await updateImageProcessing(id, {
        cropRect: item.cropRect,
        enhanceEnabled: enabled,
      });
    },
    [images, updateImageProcessing],
  );

  const handleFileInput = (e) => {
    if (e.target.files?.length) {
      addFiles(e.target.files);
      e.target.value = '';
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files?.length) {
      addFiles(e.dataTransfer.files);
    }
  };

  const removeImage = (id) => {
    setImages((prev) => prev.filter((img) => img.id !== id));
    if (previewId === id) setPreviewId(null);
    setMergedBlob(null);
  };

  const updateName = (id, name) => {
    setImages((prev) =>
      prev.map((img) => (img.id === id ? { ...img, customName: name } : img)),
    );
    setMergedBlob(null);
  };

  const reorder = (fromIndex, toIndex) => {
    if (fromIndex === toIndex || fromIndex == null || toIndex == null) return;
    setImages((prev) => {
      const next = [...prev];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
    setMergedBlob(null);
  };

  const handleConvert = async () => {
    if (images.length === 0 || isConverting) return;

    setIsConverting(true);
    setMergedBlob(null);
    setProgress('Memulai konversi...');

    try {
      if (mode === 'separate') {
        const updated = [];
        for (let i = 0; i < images.length; i++) {
          const item = images[i];
          setProgress(`Mengonversi ${i + 1} dari ${images.length}...`);
          const pdfBlob = await convertSingleImage(item.file, item.dataUrl);
          updated.push({ ...item, pdfBlob });
        }
        setImages(updated);
        setProgress('');
      } else {
        setProgress('Menggabungkan gambar ke PDF...');
        const blob = await convertMergedImages(images);
        setMergedBlob(blob);
        setProgress('');
      }
    } catch (err) {
      console.error(err);
      setProgress('Gagal konversi. Coba lagi.');
    } finally {
      setIsConverting(false);
    }
  };

  const previewItem = images.find((img) => img.id === previewId);

  const allConverted =
    mode === 'separate' &&
    images.length > 0 &&
    images.every((img) => img.pdfBlob);

  const showOverlay = isConverting || isProcessingUpload;

  return (
    <div className="app">
      <header className="header">
        <h1>Image to PDF</h1>
        <p>Ubah gambar PNG/JPG menjadi PDF — langsung di browser, tanpa upload ke server.</p>
      </header>

      <section
        className={`upload-zone ${dragOver ? 'upload-zone--active' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click();
        }}
      >
        <div className="upload-zone__icon">📁</div>
        <p className="upload-zone__title">Tarik & lepas gambar di sini</p>
        <p className="upload-zone__hint">
          atau ketuk untuk pilih file (PNG / JPG, auto-crop otomatis saat upload)
        </p>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/jpg"
          multiple
          hidden
          onChange={handleFileInput}
        />
      </section>

      {images.length > 0 && (
        <>
          <section className="mode-section">
            <h2>Mode Konversi</h2>
            <div className="mode-options">
              <label className={`mode-option ${mode === 'separate' ? 'mode-option--active' : ''}`}>
                <input
                  type="radio"
                  name="mode"
                  value="separate"
                  checked={mode === 'separate'}
                  onChange={() => {
                    setMode('separate');
                    setMergedBlob(null);
                  }}
                />
                <span className="mode-option__label">Convert Terpisah</span>
                <span className="mode-option__desc">Tiap gambar jadi 1 PDF sendiri</span>
              </label>
              <label className={`mode-option ${mode === 'merge' ? 'mode-option--active' : ''}`}>
                <input
                  type="radio"
                  name="mode"
                  value="merge"
                  checked={mode === 'merge'}
                  onChange={() => setMode('merge')}
                />
                <span className="mode-option__label">Gabung Jadi 1 PDF</span>
                <span className="mode-option__desc">Semua gambar jadi multi-halaman</span>
              </label>
            </div>

            {mode === 'merge' && (
              <div className="merged-name">
                <label htmlFor="merged-name">Nama file hasil gabungan</label>
                <input
                  id="merged-name"
                  type="text"
                  value={mergedName}
                  onChange={(e) => {
                    setMergedName(e.target.value);
                    setMergedBlob(null);
                  }}
                  placeholder="gabungan"
                />
              </div>
            )}
          </section>

          <section className="image-list-section">
            <div className="section-header">
              <h2>Gambar ({images.length})</h2>
              <p className="hint">Ketuk thumbnail untuk preview · seret item untuk urutkan</p>
            </div>

            <ul className="image-list">
              {images.map((item, index) => (
                <li
                  key={item.id}
                  className={`image-item ${dragIndex === index ? 'image-item--dragging' : ''}`}
                  draggable
                  onDragStart={() => setDragIndex(index)}
                  onDragEnd={() => setDragIndex(null)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    reorder(dragIndex, index);
                    setDragIndex(null);
                  }}
                >
                  <div className="image-item__drag" aria-hidden="true">
                    ⠿
                  </div>
                  <button
                    type="button"
                    className="image-item__thumb-btn"
                    onClick={() => setPreviewId(item.id)}
                    aria-label={`Preview ${item.customName}`}
                  >
                    <img
                      className="image-item__thumb"
                      src={item.dataUrl}
                      alt={item.customName}
                      draggable={false}
                    />
                    {item.autoCropApplied && (
                      <span className="image-item__tag">Auto-crop</span>
                    )}
                  </button>
                  <div className="image-item__body">
                    <label className="sr-only" htmlFor={`name-${item.id}`}>
                      Nama file
                    </label>
                    <input
                      id={`name-${item.id}`}
                      className="image-item__name"
                      type="text"
                      value={item.customName}
                      onChange={(e) => updateName(item.id, e.target.value)}
                      placeholder="Nama file"
                    />
                    <span className="image-item__meta">{item.file.name}</span>
                    <button
                      type="button"
                      className={`btn btn--tiny ${item.enhanceEnabled ? 'btn--filter-active' : 'btn--filter'}`}
                      onClick={() => handleToggleEnhance(item.id, !item.enhanceEnabled)}
                    >
                      {item.enhanceEnabled ? '✓ Perjelas' : 'Perjelas Gambar'}
                    </button>
                  </div>
                  <div className="image-item__actions">
                    {mode === 'separate' && item.pdfBlob && (
                      <button
                        type="button"
                        className="btn btn--small btn--success"
                        onClick={() => downloadBlob(item.pdfBlob, item.customName)}
                      >
                        Download
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn--small btn--danger"
                      onClick={() => removeImage(item.id)}
                      aria-label="Hapus gambar"
                    >
                      ✕
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>

          <section className="actions">
            <button
              type="button"
              className="btn btn--primary btn--large"
              onClick={handleConvert}
              disabled={isConverting || images.length === 0}
            >
              {isConverting ? 'Mengonversi...' : 'Convert ke PDF'}
            </button>

            {mode === 'separate' && allConverted && (
              <button
                type="button"
                className="btn btn--secondary btn--large"
                onClick={() => downloadAllSequentially(images)}
              >
                Download Semua
              </button>
            )}

            {mode === 'merge' && mergedBlob && (
              <button
                type="button"
                className="btn btn--secondary btn--large"
                onClick={() => downloadBlob(mergedBlob, mergedName)}
              >
                Download PDF Gabungan
              </button>
            )}
          </section>
        </>
      )}

      {previewItem && (
        <ImagePreviewModal
          item={previewItem}
          onClose={() => setPreviewId(null)}
          onApplyChanges={applyImageChanges}
          onToggleEnhance={handleToggleEnhance}
        />
      )}

      {showOverlay && (
        <div className="overlay" role="status" aria-live="polite">
          <div className="spinner" />
          <p>{progress || 'Memproses...'}</p>
        </div>
      )}
    </div>
  );
}

export default App;
