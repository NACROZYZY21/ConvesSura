import { useEffect, useRef } from 'react';

export default function GroupNameModal({ defaultName, onConfirm, onCancel }) {
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  const handleSubmit = (e) => {
    e.preventDefault();
    const name = inputRef.current?.value.trim();
    if (name) onConfirm(name);
  };

  return (
    <div className="modal-backdrop" onClick={onCancel} role="presentation">
      <div
        className="modal modal--small"
        role="dialog"
        aria-modal="true"
        aria-labelledby="group-name-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal__header">
          <h2 id="group-name-title">Nama PDF Grup</h2>
        </div>
        <form className="group-name-form" onSubmit={handleSubmit}>
          <p className="group-name-form__hint">
            Gambar terpilih akan digabung jadi 1 PDF multi-halaman.
          </p>
          <input
            ref={inputRef}
            type="text"
            defaultValue={defaultName}
            placeholder="Nama file grup"
            required
          />
          <div className="group-name-form__actions">
            <button type="button" className="btn btn--outline btn--small" onClick={onCancel}>
              Batal
            </button>
            <button type="submit" className="btn btn--primary btn--small">
              Buat Grup
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
