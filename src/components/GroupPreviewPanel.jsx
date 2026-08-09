export default function GroupPreviewPanel({
  selectedImages,
  groupName,
  onGroupNameChange,
  onCreateGroup,
  onClearSelection,
}) {
  if (selectedImages.length < 2) return null;

  return (
    <section className="group-preview-panel">
      <div className="group-preview-panel__header">
        <h2>Preview PDF Gabungan</h2>
        <span>{selectedImages.length} halaman dipilih</span>
      </div>

      <div className="group-preview-panel__pages">
        {selectedImages.map((item, index) => (
          <figure key={item.id} className="group-preview-page">
            <img src={item.dataUrl} alt={`Halaman ${index + 1}`} />
            <figcaption>Halaman {index + 1}</figcaption>
          </figure>
        ))}
      </div>

      <div className="group-preview-panel__form">
        <label htmlFor="draft-group-name">Nama file PDF gabungan</label>
        <input
          id="draft-group-name"
          type="text"
          value={groupName}
          onChange={(e) => onGroupNameChange(e.target.value)}
          placeholder="contoh: dokumen-gabungan"
        />
      </div>

      <div className="group-preview-panel__actions">
        <button type="button" className="btn btn--primary btn--small" onClick={onCreateGroup}>
          Buat Grup Ini
        </button>
        <button type="button" className="btn btn--outline btn--small" onClick={onClearSelection}>
          Batal Pilih
        </button>
      </div>
    </section>
  );
}
