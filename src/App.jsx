import { useCallback, useRef, useState } from 'react';
import GroupNameModal from './components/GroupNameModal';
import ImagePreviewModal from './components/ImagePreviewModal';
import {
  convertMergedImages,
  convertSingleImage,
  downloadAllSequentially,
  downloadBlob,
  fileToDataUrl,
  stripExtension,
} from './utils/pdfConverter';
import {
  buildDownloadQueue,
  getGroupForImage,
  getGroupImagesInOrder,
  getUngroupedImages,
  isSeparateConvertComplete,
  removeImageFromGroups,
} from './utils/groupHelpers';
import { buildProcessedImage, processUploadedImage } from './utils/imageProcessing';
import './App.css';

function createId() {
  return crypto.randomUUID();
}

const GROUP_COLORS = ['#6366f1', '#10b981', '#f59e0b', '#ec4899', '#0ea5e9', '#8b5cf6'];

function App() {
  const [images, setImages] = useState([]);
  const [groups, setGroups] = useState([]);
  const [selectedIds, setSelectedIds] = useState([]);
  const [showGroupModal, setShowGroupModal] = useState(false);
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

  const clearPdfResults = useCallback(() => {
    setMergedBlob(null);
    setImages((prev) => prev.map((img) => ({ ...img, pdfBlob: null })));
    setGroups((prev) => prev.map((g) => ({ ...g, pdfBlob: null })));
  }, []);

  const getGroupColor = (groupId) => {
    const index = groups.findIndex((g) => g.id === groupId);
    return GROUP_COLORS[index % GROUP_COLORS.length];
  };

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
      clearPdfResults();
    } finally {
      setIsProcessingUpload(false);
      setProgress('');
    }
  }, [clearPdfResults]);

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
          ? { ...img, cropRect, enhanceEnabled, autoCropApplied, dataUrl, pdfBlob: null }
          : { ...img, pdfBlob: null },
      ),
    );
    setGroups((prev) => prev.map((g) => ({ ...g, pdfBlob: null })));
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

  const toggleSelect = (id) => {
    if (getGroupForImage(id, groups)) return;

    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const handleCreateGroup = (name) => {
    if (selectedIds.length < 2) return;

    setGroups((prev) => [
      ...prev,
      {
        id: createId(),
        name,
        imageIds: [...selectedIds],
        pdfBlob: null,
      },
    ]);
    setSelectedIds([]);
    setShowGroupModal(false);
    clearPdfResults();
  };

  const removeGroup = (groupId) => {
    setGroups((prev) => prev.filter((g) => g.id !== groupId));
    clearPdfResults();
  };

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
    setGroups((prev) => removeImageFromGroups(prev, id));
    setSelectedIds((prev) => prev.filter((x) => x !== id));
    if (previewId === id) setPreviewId(null);
    clearPdfResults();
  };

  const updateName = (id, name) => {
    setImages((prev) =>
      prev.map((img) => (img.id === id ? { ...img, customName: name } : img)),
    );
    clearPdfResults();
  };

  const reorder = (fromIndex, toIndex) => {
    if (fromIndex === toIndex || fromIndex == null || toIndex == null) return;
    setImages((prev) => {
      const next = [...prev];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
    clearPdfResults();
  };

  const handleConvert = async () => {
    if (images.length === 0 || isConverting) return;

    setIsConverting(true);
    setMergedBlob(null);
    setProgress('Memulai konversi...');

    try {
      if (mode === 'separate') {
        const ungrouped = getUngroupedImages(images, groups);
        let step = 0;
        const totalSteps = groups.length + ungrouped.length;

        const updatedGroups = [];
        for (const group of groups) {
          step++;
          setProgress(`Mengonversi grup "${group.name}" (${step}/${totalSteps})...`);
          const groupImages = getGroupImagesInOrder(images, group);
          const pdfBlob = await convertMergedImages(groupImages);
          updatedGroups.push({ ...group, pdfBlob });
        }

        const updatedImages = [...images];
        for (const item of ungrouped) {
          step++;
          setProgress(`Mengonversi ${item.customName} (${step}/${totalSteps})...`);
          const pdfBlob = await convertSingleImage(item.file, item.dataUrl);
          const idx = updatedImages.findIndex((img) => img.id === item.id);
          if (idx !== -1) {
            updatedImages[idx] = { ...updatedImages[idx], pdfBlob };
          }
        }

        setGroups(updatedGroups);
        setImages(updatedImages);
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
  const selectableSelected = selectedIds.filter((id) => !getGroupForImage(id, groups));
  const canCreateGroup = mode === 'separate' && selectableSelected.length >= 2;
  const allConverted =
    mode === 'separate'
      ? isSeparateConvertComplete(images, groups)
      : false;
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
                <span className="mode-option__desc">
                  Tiap gambar jadi PDF sendiri, atau gabung selektif via grup
                </span>
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

          {mode === 'separate' && groups.length > 0 && (
            <section className="groups-section">
              <h2>Grup PDF ({groups.length})</h2>
              <ul className="groups-list">
                {groups.map((group) => (
                  <li key={group.id} className="group-card">
                    <span
                      className="group-card__dot"
                      style={{ background: getGroupColor(group.id) }}
                    />
                    <div className="group-card__info">
                      <strong>{group.name}</strong>
                      <span>{group.imageIds.length} gambar · urutan sesuai list</span>
                    </div>
                    <div className="group-card__actions">
                      {group.pdfBlob && (
                        <button
                          type="button"
                          className="btn btn--small btn--success"
                          onClick={() => downloadBlob(group.pdfBlob, group.name)}
                        >
                          Download
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn btn--small btn--outline"
                        onClick={() => removeGroup(group.id)}
                      >
                        Hapus Grup
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="image-list-section">
            <div className="section-header">
              <h2>Gambar ({images.length})</h2>
              <p className="hint">
                {mode === 'separate'
                  ? 'Centang gambar → buat grup · ketuk thumbnail untuk preview'
                  : 'Ketuk thumbnail untuk preview · seret item untuk urutkan'}
              </p>
            </div>

            {mode === 'separate' && canCreateGroup && (
              <div className="selection-bar">
                <span>{selectableSelected.length} gambar dipilih</span>
                <button
                  type="button"
                  className="btn btn--small btn--primary"
                  onClick={() => setShowGroupModal(true)}
                >
                  Gabung Jadi 1 PDF
                </button>
              </div>
            )}

            <ul className="image-list">
              {images.map((item, index) => {
                const group = getGroupForImage(item.id, groups);
                const isSelected = selectedIds.includes(item.id);
                const canSelect = mode === 'separate' && !group;

                return (
                  <li
                    key={item.id}
                    className={`image-item ${dragIndex === index ? 'image-item--dragging' : ''} ${isSelected ? 'image-item--selected' : ''}`}
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
                    style={
                      group
                        ? { borderLeftColor: getGroupColor(group.id), borderLeftWidth: '4px' }
                        : undefined
                    }
                  >
                    {canSelect && (
                      <label className="image-item__check">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleSelect(item.id)}
                        />
                      </label>
                    )}
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
                      {group && (
                        <span
                          className="image-item__tag image-item__tag--group"
                          style={{ background: getGroupColor(group.id) }}
                        >
                          {group.name}
                        </span>
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
                        disabled={!!group}
                      />
                      <span className="image-item__meta">
                        {group ? `Grup: ${group.name}` : item.file.name}
                      </span>
                      <button
                        type="button"
                        className={`btn btn--tiny ${item.enhanceEnabled ? 'btn--filter-active' : 'btn--filter'}`}
                        onClick={() => handleToggleEnhance(item.id, !item.enhanceEnabled)}
                      >
                        {item.enhanceEnabled ? '✓ Perjelas' : 'Perjelas Gambar'}
                      </button>
                    </div>
                    <div className="image-item__actions">
                      {mode === 'separate' && !group && item.pdfBlob && (
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
                );
              })}
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
                onClick={() => downloadAllSequentially(buildDownloadQueue(images, groups))}
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

      {showGroupModal && (
        <GroupNameModal
          defaultName={`grup-${groups.length + 1}`}
          onConfirm={handleCreateGroup}
          onCancel={() => setShowGroupModal(false)}
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
