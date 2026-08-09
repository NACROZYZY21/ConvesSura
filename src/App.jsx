import { useCallback, useRef, useState } from 'react';
import GroupPreviewPanel from './components/GroupPreviewPanel';
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
import { buildProcessedImage, processUploadedImage, rapikanImage, fullCropRect, getImageDimensions, isRapikanDone } from './utils/imageProcessing';
import './App.css';

function createId() {
  return crypto.randomUUID();
}

const GROUP_COLORS = ['#6366f1', '#10b981', '#f59e0b', '#ec4899', '#0ea5e9', '#8b5cf6'];

function App() {
  const [images, setImages] = useState([]);
  const [groups, setGroups] = useState([]);
  const [selectedIds, setSelectedIds] = useState([]);
  const [draftGroupName, setDraftGroupName] = useState('gabungan');
  const [mode, setMode] = useState('separate');
  const [mergedName, setMergedName] = useState('gabungan');
  const [mergedBlob, setMergedBlob] = useState(null);
  const [isConverting, setIsConverting] = useState(false);
  const [isProcessingUpload, setIsProcessingUpload] = useState(false);
  const [progress, setProgress] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [dragIndex, setDragIndex] = useState(null);
  const [previewId, setPreviewId] = useState(null);
  const [previewInitialMode, setPreviewInitialMode] = useState('preview');
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
    setProgress('Memuat gambar...');

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
    if (!current) return null;

    const merged = { ...current, ...patch };
    const cropRect = merged.cropRect;
    const enhanceEnabled = merged.enhanceEnabled ?? false;
    const autoCropApplied = merged.autoCropApplied ?? false;
    const autoEnhanceApplied = merged.autoEnhanceApplied ?? false;

    const { dataUrl } = await buildProcessedImage(merged, cropRect, enhanceEnabled);

    setImages((prev) =>
      prev.map((img) =>
        img.id === id
          ? {
              ...merged,
              dataUrl,
              pdfBlob: null,
            }
          : { ...img, pdfBlob: null },
      ),
    );
    setGroups((prev) => prev.map((g) => ({ ...g, pdfBlob: null })));
    setMergedBlob(null);

    return {
      dataUrl,
      enhanceEnabled,
      cropRect,
      autoCropApplied,
      autoEnhanceApplied,
      scanBaseDataUrl: merged.scanBaseDataUrl,
      autoCropRect: merged.autoCropRect,
    };
  }, []);

  const handleRapikan = useCallback(
    async (id) => {
      const item = imagesRef.current.find((img) => img.id === id);
      if (!item) return null;

      try {
        const tidied = await rapikanImage(item.originalDataUrl, item.enhanceEnabled ?? false);
        const result = await updateImageProcessing(id, {
          scanBaseDataUrl: tidied.scanBaseDataUrl,
          cropRect: tidied.cropRect,
          autoCropRect: tidied.autoCropRect,
          autoCropApplied: tidied.autoCropApplied,
          enhanceEnabled: item.enhanceEnabled ?? false,
          autoEnhanceApplied: item.autoEnhanceApplied ?? false,
        });
        return result ? { ...result, rapikanFailed: !isRapikanDone({ ...item, ...result, scanBaseDataUrl: result.scanBaseDataUrl }) } : null;
      } catch (err) {
        console.error(err);
        return { rapikanFailed: true, error: err.message };
      }
    },
    [updateImageProcessing],
  );

  const handleResetOriginal = useCallback(
    async (id) => {
      const item = imagesRef.current.find((img) => img.id === id);
      if (!item) return null;

      try {
        const dims = await getImageDimensions(item.originalDataUrl);
        const fullRect = fullCropRect(dims.width, dims.height);
        return updateImageProcessing(id, {
          scanBaseDataUrl: item.originalDataUrl,
          cropRect: fullRect,
          autoCropRect: fullRect,
          autoCropApplied: false,
          enhanceEnabled: item.enhanceEnabled ?? false,
          autoEnhanceApplied: item.autoEnhanceApplied ?? false,
        });
      } catch (err) {
        console.error(err);
        return null;
      }
    },
    [updateImageProcessing],
  );

  const applyImageChanges = useCallback(
    async (id, { cropRect, enhanceEnabled }) => {
      await updateImageProcessing(id, {
        cropRect,
        enhanceEnabled,
        autoCropApplied: true,
      });
    },
    [updateImageProcessing],
  );

  const handleToggleEnhance = useCallback(
    async (id, enabled) => {
      const item = imagesRef.current.find((img) => img.id === id);
      if (!item) return null;

      return updateImageProcessing(id, {
        cropRect: item.cropRect,
        enhanceEnabled: enabled,
        autoEnhanceApplied: enabled,
      });
    },
    [updateImageProcessing],
  );

  const openPreview = useCallback((id, mode = 'preview') => {
    setPreviewInitialMode(mode);
    setPreviewId(id);
  }, []);

  const handleRapikanSemua = useCallback(async () => {
    const pending = imagesRef.current.filter((img) => !isRapikanDone(img));
    if (pending.length === 0) return;

    setIsProcessingUpload(true);
    let failed = 0;
    try {
      for (let i = 0; i < pending.length; i++) {
        const item = pending[i];
        setProgress(`Merapikan ${i + 1}/${pending.length}: ${item.customName}`);
        const result = await handleRapikan(item.id);
        if (result?.rapikanFailed) failed++;
      }
      setProgress(
        failed > 0
          ? `Selesai — ${failed} gambar perlu Edit Crop manual`
          : `Semua gambar dirapikan (${pending.length})`,
      );
      await new Promise((r) => setTimeout(r, 1200));
    } finally {
      setIsProcessingUpload(false);
      setProgress('');
    }
  }, [handleRapikan]);

  const handlePerjelasSemua = useCallback(async () => {
    const pending = imagesRef.current.filter((img) => !img.enhanceEnabled);
    if (pending.length === 0) return;

    setIsProcessingUpload(true);
    try {
      for (let i = 0; i < pending.length; i++) {
        const item = pending[i];
        setProgress(`Memperjelas ${i + 1}/${pending.length}: ${item.customName}`);
        await handleToggleEnhance(item.id, true);
      }
      setProgress(`Semua gambar diperjelas (${pending.length})`);
      await new Promise((r) => setTimeout(r, 1200));
    } finally {
      setIsProcessingUpload(false);
      setProgress('');
    }
  }, [handleToggleEnhance]);

  const handleRapikanPerjelasSemua = useCallback(async () => {
    const list = imagesRef.current;
    if (list.length === 0) return;

    setIsProcessingUpload(true);
    let rapikanFailed = 0;
    try {
      const needRapikan = list.filter((img) => !isRapikanDone(img));
      for (let i = 0; i < needRapikan.length; i++) {
        const item = needRapikan[i];
        setProgress(`Merapikan ${i + 1}/${needRapikan.length}: ${item.customName}`);
        const result = await handleRapikan(item.id);
        if (result?.rapikanFailed) rapikanFailed++;
      }

      const needPerjelas = imagesRef.current.filter((img) => !img.enhanceEnabled);
      for (let i = 0; i < needPerjelas.length; i++) {
        const item = needPerjelas[i];
        setProgress(`Memperjelas ${i + 1}/${needPerjelas.length}: ${item.customName}`);
        await handleToggleEnhance(item.id, true);
      }

      if (rapikanFailed > 0) {
        setProgress(`${rapikanFailed} gambar perlu Edit Crop manual — sisanya selesai`);
      } else {
        setProgress('Semua gambar dirapikan & diperjelas');
      }
      await new Promise((r) => setTimeout(r, 1200));
    } finally {
      setIsProcessingUpload(false);
      setProgress('');
    }
  }, [handleRapikan, handleToggleEnhance]);

  const toggleSelect = (id) => {
    if (getGroupForImage(id, groups)) return;

    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const handleCreateGroup = () => {
    const name = draftGroupName.trim();
    if (!name || selectedIds.length < 2) return;

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
    setDraftGroupName(`gabungan-${groups.length + 2}`);
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
  const selectedImages = images.filter(
    (img) => selectedIds.includes(img.id) && !getGroupForImage(img.id, groups),
  );
  const rapikanCount = images.filter((img) => isRapikanDone(img)).length;
  const perjelasCount = images.filter((img) => img.enhanceEnabled).length;
  const rapikanPending = images.length - rapikanCount;
  const perjelasPending = images.length - perjelasCount;
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
          PNG / JPG · upload dulu, lalu rapikan & perjelas manual (per file atau semua sekaligus)
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
                {groups.map((group) => {
                  const groupImages = getGroupImagesInOrder(images, group);
                  return (
                    <li key={group.id} className="group-card group-card--expanded">
                      <div className="group-card__top">
                        <span
                          className="group-card__dot"
                          style={{ background: getGroupColor(group.id) }}
                        />
                        <div className="group-card__info">
                          <strong>{group.name}.pdf</strong>
                          <span>{group.imageIds.length} halaman · urutan sesuai list</span>
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
                            Bubarkan Grup
                          </button>
                        </div>
                      </div>
                      <div className="group-card__pages">
                        {groupImages.map((img, index) => (
                          <figure key={img.id} className="group-preview-page group-preview-page--small">
                            <img src={img.dataUrl} alt={`${group.name} halaman ${index + 1}`} />
                            <figcaption>H{index + 1}</figcaption>
                          </figure>
                        ))}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          <section className="image-list-section">
            <div className="section-header">
              <h2>Gambar ({images.length})</h2>
              <p className="hint">
                {mode === 'separate'
                  ? 'Centang gambar → buat grup · ketuk thumbnail untuk preview · Edit untuk crop manual'
                  : 'Ketuk thumbnail untuk preview · Edit untuk crop manual · seret item untuk urutkan'}
              </p>
            </div>

            <div className="batch-toolbar">
              <div className="batch-toolbar__status" role="status">
                <span className="batch-toolbar__stat batch-toolbar__stat--rapikan">
                  Rapikan: {rapikanCount}/{images.length}
                </span>
                <span className="batch-toolbar__stat batch-toolbar__stat--perjelas">
                  Perjelas: {perjelasCount}/{images.length}
                </span>
              </div>
              <div className="batch-toolbar__actions">
                <button
                  type="button"
                  className="btn btn--small btn--outline"
                  onClick={handleRapikanSemua}
                  disabled={isProcessingUpload || rapikanPending === 0}
                >
                  Rapikan Semua{rapikanPending > 0 ? ` (${rapikanPending})` : ''}
                </button>
                <button
                  type="button"
                  className="btn btn--small btn--filter"
                  onClick={handlePerjelasSemua}
                  disabled={isProcessingUpload || perjelasPending === 0}
                >
                  Perjelas Semua{perjelasPending > 0 ? ` (${perjelasPending})` : ''}
                </button>
                <button
                  type="button"
                  className="btn btn--small btn--secondary"
                  onClick={handleRapikanPerjelasSemua}
                  disabled={
                    isProcessingUpload || (rapikanPending === 0 && perjelasPending === 0)
                  }
                >
                  Rapikan + Perjelas Semua
                </button>
              </div>
            </div>

            <ul className="image-list">
              {images.map((item, index) => {
                const group = getGroupForImage(item.id, groups);
                const isSelected = selectedIds.includes(item.id);
                const canSelect = mode === 'separate' && !group;

                return (
                  <li
                    key={item.id}
                    className={`image-item ${dragIndex === index ? 'image-item--dragging' : ''} ${isSelected ? 'image-item--selected' : ''} ${isRapikanDone(item) ? 'image-item--rapikan' : 'image-item--raw'}`}
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
                      onClick={() => openPreview(item.id, 'preview')}
                      aria-label={`Preview ${item.customName}`}
                    >
                      <img
                        className="image-item__thumb"
                        src={item.dataUrl}
                        alt={item.customName}
                        draggable={false}
                      />
                      <div className="image-item__tags">
                        {isRapikanDone(item) ? (
                          <span className="image-item__tag">Rapikan</span>
                        ) : (
                          <span className="image-item__tag image-item__tag--pending">Belum rapikan</span>
                        )}
                        {item.enhanceEnabled && (
                          <span className="image-item__tag image-item__tag--enhance">Perjelas</span>
                        )}
                      </div>
                      {group && (
                        <span
                          className="image-item__tag image-item__tag--group"
                          style={{ background: getGroupColor(group.id) }}
                        >
                          Grup: {group.name}
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
                        {group ? `Masuk Grup: ${group.name}` : item.file.name}
                      </span>
                    </div>
                    <div className="image-item__actions">
                      <button
                        type="button"
                        className="btn btn--small btn--outline btn--tiny"
                        onClick={() => openPreview(item.id, 'crop')}
                        title="Edit crop manual"
                      >
                        Edit
                      </button>
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

            {mode === 'separate' && selectedImages.length >= 2 && (
              <GroupPreviewPanel
                selectedImages={selectedImages}
                groupName={draftGroupName}
                onGroupNameChange={setDraftGroupName}
                onCreateGroup={handleCreateGroup}
                onClearSelection={() => setSelectedIds([])}
              />
            )}
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
          initialMode={previewInitialMode}
          onClose={() => setPreviewId(null)}
          onApplyChanges={applyImageChanges}
          onToggleEnhance={handleToggleEnhance}
          onRapikan={handleRapikan}
          onResetOriginal={handleResetOriginal}
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
