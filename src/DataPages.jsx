import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { AlertCircle, Download, ExternalLink, FileText, Link2, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { useWorkspace } from './store.jsx';
import { saveFileBlob, getFileBlob, deleteFileBlob, downloadText, downloadBlob } from './storage.js';
import Modal from './Modal.jsx';
import SectionHeader from './SectionHeader.jsx';
import './data-pages.css';
import RecordTable from './RecordTable.jsx';
import { filterTableRecords } from './record-table.js';
import {
  SCHEMAS,
  STATUS_ALL,
  formatDate,
  formatFieldValue,
  emptyFormFor,
  recordToForm,
  formToRecord,
  validateRecord,
  recordToMarkdown,
  recordsToCsv,
} from './records-schema.js';

function uid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function formatBytes(bytes) {
  if (bytes === undefined || bytes === null) return 'size unknown';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}
const TABLE_RECORD_KINDS = new Set(['bom', 'document', 'test', 'supplier']);
const PAGE_DESCRIPTIONS = {
  module: 'Check compatibility and licensing before use; manufacturer links are external references.',
  counterparty: 'Record evidence and open questions; this is not a trust score.',
  requirement: 'Compliance assessments require a qualified opinion.',
  expert: 'List real people only; qualifications are not verified by this app.',
  grant: 'Record deadlines only when confirmed by the program source.',
  library: 'Files are stored in this browser.',
};

const EMPTY_ILLUSTRATIONS = {
  prototype: '/illustrations/device-toy.webp',
};

const MODULE_FIELD_KEYS = new Set([
  'category',
  'manufacturer',
  'partNumber',
  'licensing',
  'compatibilityNotes',
  'evidence',
  'evidenceDate',
]);
const MODULE_TECHNICAL_FIELD_KEYS = new Set([
  'manufacturer',
  'partNumber',
  'licensing',
  'compatibilityNotes',
]);
const MODULE_EVIDENCE_FIELD_KEYS = new Set(['evidence', 'evidenceDate']);

function sourceControlId(formId, source, index) {
  return `${formId}-source-${source.id || index}-${source.type}`;
}

function recordErrorTargetId(key, formId, form) {
  if (key === 'title') return `${formId}-title`;
  if (key.startsWith('field:')) return `${formId}-${key.slice(6)}`;
  if (key.startsWith('source:')) {
    const index = Number(key.slice(7));
    const source = form.sources?.[index];
    return source ? sourceControlId(formId, source, index) : null;
  }
  if (key === 'libraryFile') return `${formId}-file`;
  return null;
}

function recordErrorLabel(key, schema) {
  if (key === 'title') return 'Title';
  if (key.startsWith('field:')) {
    return schema.fields.find(field => field.key === key.slice(6))?.label || 'Record field';
  }
  if (key.startsWith('source:')) return `Source ${Number(key.slice(7)) + 1}`;
  if (key === 'libraryFile') return 'File';
  if (key === 'libraryContent') return 'Library content';
  return 'Record';
}

function serializeEditableForm(form) {
  return JSON.stringify({
    title: form.title,
    notes: form.notes,
    status: form.status,
    fields: form.fields || {},
    sources: form.sources || [],
    fileMeta: form.fileMeta || null,
  });
}


function FieldInput({ field, formId, value, onChange, error }) {
  const id = `${formId}-${field.key}`;
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const describedBy = [field.hint ? hintId : null, error ? errorId : null]
    .filter(Boolean).join(' ') || undefined;
  const fieldClassName = field.type === 'textarea' ? 'field record-page__field--wide' : 'field';
  const errorProps = {
    required: Boolean(field.required && field.type !== 'boolean'),
    'aria-invalid': error ? 'true' : undefined,
    'aria-describedby': describedBy,
  };
  if (field.type === 'boolean') {
    return (
      <div className={fieldClassName}>
        <label htmlFor={id}>
          <input
            id={id}
            type="checkbox"
            checked={!!value}
            onChange={(e) => onChange(e.target.checked)}
            {...errorProps}
          /> {field.label}
        </label>
        {field.hint && <p id={hintId} className="muted">{field.hint}</p>}
        {error && <p id={errorId} className="notice"><AlertCircle size={14} aria-hidden="true" /> {error}</p>}
      </div>
    );
  }
  let control;
  if (field.type === 'textarea') {
    control = <textarea id={id} rows={3} value={value} onChange={(e) => onChange(e.target.value)} {...errorProps} />;
  } else if (field.type === 'select') {
    control = (
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} {...errorProps}>
        <option value="">— not selected —</option>
        {field.options.map((opt) => (
          <option key={opt} value={opt}>{opt}</option>
        ))}
      </select>
    );
  } else if (field.type === 'number') {
    control = <input id={id} type="number" step="any" value={value} onChange={(e) => onChange(e.target.value)} {...errorProps} />;
  } else if (field.type === 'date') {
    control = <input id={id} type="date" value={value} onChange={(e) => onChange(e.target.value)} {...errorProps} />;
  } else {
    control = <input id={id} type="text" value={value} onChange={(e) => onChange(e.target.value)} {...errorProps} />;
  }
  return (
    <div className={fieldClassName}>
      <label htmlFor={id}>{field.label}{field.required ? ' *' : ''}</label>
      {control}
      {field.hint && <p id={hintId} className="muted">{field.hint}</p>}
      {error && <p id={errorId} className="notice"><AlertCircle size={14} aria-hidden="true" /> {error}</p>}
    </div>
  );
}

function SourcesEditor({ formId, sources, onChange, libraryRecords, errors }) {
  function patch(idx, next) {
    onChange(sources.map((source, i) => (i === idx ? next : source)));
  }
  function remove(idx) {
    onChange(sources.filter((_, i) => i !== idx));
  }
  function addUrl() {
    onChange([...sources, { id: uid(), type: 'url', url: '', label: '' }]);
  }
  function addLibrary() {
    onChange([...sources, { id: uid(), type: 'library', recordId: '', label: '' }]);
  }
  return (
    <div className="field record-page__sources record-page__field--wide">
      <div className="record-page__sources-heading">
        <h3>Sources</h3>
        <div className="page-actions">
          <button type="button" className="button secondary" onClick={addUrl}><Link2 size={16} aria-hidden="true" /> Add link</button>
          <button type="button" className="button secondary" onClick={addLibrary}><FileText size={16} aria-hidden="true" /> Link library record</button>
        </div>
      </div>
      <div className="record-page__source-entries">
        {sources.map((source, idx) => {
          const error = errors['source:' + idx];
          const controlId = sourceControlId(formId, source, idx);
          const errorId = `${controlId}-error`;
          const errorProps = {
            required: true,
            'aria-invalid': error ? 'true' : undefined,
            'aria-describedby': error ? errorId : undefined,
          };
          return (
            <div key={source.id} className="panel panel--quiet record-page__source-row">
              <div className="form-grid">
                {source.type === 'url' ? (
                  <>
                    <div className="field">
                      <label htmlFor={controlId}>Link (http/https)</label>
                      <input id={controlId} type="url" value={source.url} onChange={(e) => patch(idx, { ...source, url: e.target.value })} {...errorProps} />
                      {error && <p id={errorId} className="notice"><AlertCircle size={14} aria-hidden="true" /> {error}</p>}
                    </div>
                    <div className="field">
                      <label htmlFor={`${controlId}-label`}>Source name</label>
                      <input id={`${controlId}-label`} type="text" value={source.label} onChange={(e) => patch(idx, { ...source, label: e.target.value })} />
                    </div>
                  </>
                ) : (
                  <div className="field">
                    <label htmlFor={controlId}>Library record</label>
                    <select id={controlId} value={source.recordId} onChange={(e) => patch(idx, { ...source, recordId: e.target.value })} {...errorProps}>
                      <option value="">— select —</option>
                      {libraryRecords.map((record) => (
                        <option key={record.id} value={record.id}>{record.title || 'Untitled'}</option>
                      ))}
                    </select>
                    {error && <p id={errorId} className="notice"><AlertCircle size={14} aria-hidden="true" /> {error}</p>}
                  </div>
                )}
              </div>
              <div className="record-page__source-footer">
                <button type="button" className="button ghost" onClick={() => remove(idx)}><Trash2 size={14} aria-hidden="true" /> Remove source</button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}


export default function DataPage({ kind, initialRecordId }) {
  const schema = SCHEMAS[kind];
  const { accountId, isCurrentAccount, records, saveRecord, removeRecord, notify, go } = useWorkspace();
  const formId = useId();
  const fileInputId = `${formId}-file`;
  const fileErrorId = `${fileInputId}-error`;
  const fileContentErrorId = `${fileInputId}-content-error`;

  const [statusFilter, setStatusFilter] = useState(STATUS_ALL);
  const [query, setQuery] = useState('');
  const [modalMode, setModalMode] = useState(null); // null | 'view' | 'edit'
  const [activeRecord, setActiveRecord] = useState(null);
  const [form, setForm] = useState(null);
  const [errors, setErrors] = useState({});
  const [validationFocusRequest, setValidationFocusRequest] = useState(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [fileBusy, setFileBusy] = useState(false);
  const pendingFiles = useRef(new Set());
  const uploadToken = useRef(0);
  const formRef = useRef(null);
  const errorSummaryRef = useRef(null);
  const formBaseline = useRef(null);
  function discardPendingFiles() {
    uploadToken.current += 1;
    for (const id of pendingFiles.current) deleteFileBlob(accountId, id).catch(() => {});
    pendingFiles.current.clear();
  }
  useEffect(() => () => discardPendingFiles(), []);

  const kindRecords = useMemo(() => records.filter((r) => r.type === kind), [records, kind]);
  const libraryRecords = useMemo(() => records.filter((r) => r.type === 'library'), [records]);

  const visibleRecords = useMemo(
    () => TABLE_RECORD_KINDS.has(kind)
      ? filterTableRecords(kind, kindRecords, { query, status: statusFilter })
      : kindRecords.filter(record => statusFilter === STATUS_ALL || record.status === statusFilter),
    [kind, kindRecords, query, statusFilter],
  );
  const dirty = Boolean(
    form
    && formBaseline.current !== null
    && (serializeEditableForm(form) !== formBaseline.current || pendingFiles.current.size > 0)
  );
  useEffect(() => {
    if (initialRecordId) openView(records.find(record => record.id === initialRecordId && record.type === kind));
  }, [initialRecordId, kind]);
  useEffect(() => {
    const editor = formRef.current;
    if (!validationFocusRequest || !editor) return;
    const firstInvalid = editor.querySelector('[aria-invalid="true"]');
    if (firstInvalid) {
      firstInvalid.focus({ preventScroll: true });
      firstInvalid.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    } else if (errorSummaryRef.current) {
      errorSummaryRef.current.focus({ preventScroll: true });
      errorSummaryRef.current.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }, [validationFocusRequest]);

  if (!schema) {
    return (
      <section className="panel">
        <p className="notice"><AlertCircle size={14} /> Unknown record type: {kind}</p>
      </section>
    );
  }
  const moduleFields = kind === 'module' ? {
    basic: schema.fields.filter((field) => field.key === 'category'),
    technical: schema.fields.filter((field) => MODULE_TECHNICAL_FIELD_KEYS.has(field.key)),
    evidence: schema.fields.filter((field) => MODULE_EVIDENCE_FIELD_KEYS.has(field.key)),
    remaining: schema.fields.filter((field) => !MODULE_FIELD_KEYS.has(field.key)),
  } : null;

  function openAdd() {
    const nextForm = emptyFormFor(kind);
    formBaseline.current = serializeEditableForm(nextForm);
    setActiveRecord(null);
    setForm(nextForm);
    setErrors({});
    setValidationFocusRequest(null);
    setConfirmDeleteId(null);
    setModalMode('edit');
  }

  function openView(record) {
    if (!record) return;
    formBaseline.current = null;
    setActiveRecord(record);
    setForm(recordToForm(record));
    setErrors({});
    setValidationFocusRequest(null);
    setConfirmDeleteId(null);
    setModalMode('view');
  }

  function openEdit(record) {
    const nextForm = recordToForm(record);
    formBaseline.current = serializeEditableForm(nextForm);
    setActiveRecord(record);
    setForm(nextForm);
    setErrors({});
    setValidationFocusRequest(null);
    setConfirmDeleteId(null);
    setModalMode('edit');
  }

  function closeModal() {
    discardPendingFiles();
    formBaseline.current = null;
    setFileBusy(false);
    setModalMode(null);
    setActiveRecord(null);
    setForm(null);
    setErrors({});
    setValidationFocusRequest(null);
    if (initialRecordId) go(window.location.hash.slice(1).split('?')[0]);
  }

  function requestClose() {
    if (
      modalMode === 'edit'
      && (dirty || fileBusy)
      && !window.confirm('Discard unsaved changes? Your edits will be lost.')
    ) return;
    closeModal();
  }

  function updateField(key, value) {
    setForm((prev) => ({ ...prev, fields: { ...prev.fields, [key]: value } }));
  }

  function updateSources(next) {
    setForm((prev) => ({ ...prev, sources: next }));
  }

  async function handleFileChange(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) {
      setErrors((prev) => ({ ...prev, libraryFile: 'File is larger than 20 MB — choose a smaller file' }));
      return;
    }
    setFileBusy(true);
    const newFileId = uid();
    const token = ++uploadToken.current;
    try {
      await saveFileBlob(accountId, newFileId, file);
      if (token !== uploadToken.current || !isCurrentAccount()) { await deleteFileBlob(accountId, newFileId); return; }
      pendingFiles.current.add(newFileId);
      const oldFileId = form && form.fileMeta ? form.fileMeta.fileId : null;
      setForm((prev) => ({
        ...prev,
        fileMeta: { fileId: newFileId, fileName: file.name, fileSize: file.size, fileMime: file.type || 'application/octet-stream' },
      }));
      setErrors((prev) => {
        const next = { ...prev };
        delete next.libraryFile;
        delete next.libraryContent;
        return next;
      });
      if (oldFileId && oldFileId !== newFileId && pendingFiles.current.delete(oldFileId)) {
        try { await deleteFileBlob(accountId, oldFileId); } catch (_e) { /* unused draft blob */ }
      }
    } catch (err) {
      if (token === uploadToken.current) setErrors((prev) => ({ ...prev, libraryFile: 'Failed to save the file to browser storage: ' + (err && err.message ? err.message : 'unknown error') }));
    } finally {
      if (token === uploadToken.current) setFileBusy(false);
    }
  }

  async function handleFileDownload(fileMeta) {
    if (!fileMeta || !fileMeta.fileId) { notify('File has not been uploaded yet'); return; }
    try {
      const blob = await getFileBlob(accountId, fileMeta.fileId);
      if (!isCurrentAccount()) return;
      if (!blob) { notify('File not found in local browser storage'); return; }
      downloadBlob(blob, fileMeta.fileName || 'file');
    } catch (err) {
      notify('Error reading file: ' + (err && err.message ? err.message : 'unknown error'));
    }
  }
  function focusErrorControl(targetId) {
    const target = document.getElementById(targetId);
    if (!target || !formRef.current?.contains(target)) return;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function handleSubmit(e) {
    e.preventDefault();
    if (fileBusy) { notify('Wait for the file to finish saving.'); return; }
    const errs = validateRecord(kind, form);
    if (Object.keys(errs).length) {
      setErrors(errs);
      setValidationFocusRequest(errs);
      return;
    }
    const payload = formToRecord(kind, form);
    const saved = saveRecord(payload);
    if (!saved) {
      const saveError = { global: 'Failed to save the record. Check the data and try again.' };
      setErrors(saveError);
      setValidationFocusRequest(saveError);
      return;
    }
    pendingFiles.current.delete(saved.fields?.fileId);
    const previousFileId = activeRecord?.fields?.fileId;
    if (previousFileId && previousFileId !== saved.fields?.fileId) deleteFileBlob(accountId, previousFileId).catch(() => {});
    notify('Record saved');
    const savedForm = recordToForm(saved);
    formBaseline.current = serializeEditableForm(savedForm);
    setActiveRecord(saved);
    setForm(savedForm);
    setModalMode('view');
    setErrors({});
    setValidationFocusRequest(null);
  }

  async function handleDelete(record) {
    const fileId = record.type === 'library' ? record.fields?.fileId : null;
    const ok = removeRecord(record.id);
    setConfirmDeleteId(null);
    if (ok) {
      if (fileId) {
        try { await deleteFileBlob(accountId, fileId); } catch (_e) { notify('Record deleted, but the browser could not clean up the attachment.'); return; }
      }
      if (!isCurrentAccount()) return;
      notify('Record deleted');
      if (activeRecord && activeRecord.id === record.id) closeModal();
    } else {
      notify('Failed to delete the record');
    }
  }

  function exportRecordMarkdown(record) {
    const md = recordToMarkdown(kind, record, libraryRecords);
    downloadText(md, schema.label + ' - ' + (record.title || record.id) + '.md');
  }

  function exportListCsv() {
    const csv = recordsToCsv(kind, visibleRecords, libraryRecords);
    downloadText(csv, schema.plural + '.csv', 'text/csv;charset=utf-8');
  }

  function renderRecordActions(record) {
    const title = record.title || 'Untitled';
    return (
      <>
        <button type="button" id={`record-edit-${record.id}`} data-focus-fallback={`record-title-${record.id}`} className="icon-button" aria-label={`Edit ${title}`} title="Edit" onClick={() => openEdit(record)}><Pencil size={18} aria-hidden="true" /></button>
        <button type="button" className="icon-button" aria-label={`Download ${title} as Markdown`} title="Download Markdown" onClick={() => exportRecordMarkdown(record)}><Download size={18} aria-hidden="true" /></button>
        {confirmDeleteId === record.id ? (
          <span className="chips" role="group" aria-label={`Confirm deleting ${title}`}>
            <span className="muted">Delete permanently?</span>
            <button type="button" className="button danger" onClick={() => handleDelete(record)}>Yes, delete</button>
            <button type="button" className="button secondary" onClick={() => setConfirmDeleteId(null)}>Cancel</button>
          </span>
        ) : (
          <button type="button" className="icon-button" aria-label={`Delete ${title}`} title="Delete" onClick={() => setConfirmDeleteId(record.id)}><Trash2 size={18} aria-hidden="true" /></button>
        )}
      </>
    );
  }

  function renderDetailActions(record) {
    const title = record.title || 'Untitled';
    return (
      <>
        <button type="button" className="button primary" onClick={() => openEdit(record)}><Pencil size={16} /> Edit</button>
        <button type="button" className="button secondary" onClick={() => exportRecordMarkdown(record)}><Download size={16} /> Export Markdown</button>
        {confirmDeleteId === record.id ? (
          <span className="chips" role="group" aria-label={`Confirm deleting ${title}`}>
            <span className="muted">Delete permanently?</span>
            <button type="button" className="button danger" onClick={() => handleDelete(record)}>Yes, delete</button>
            <button type="button" className="button secondary" onClick={() => setConfirmDeleteId(null)}>Cancel</button>
          </span>
        ) : (
          <button type="button" className="button secondary" onClick={() => setConfirmDeleteId(record.id)}><Trash2 size={16} /> Delete</button>
        )}
      </>
    );
  }

  function renderErrorSummary() {
    const entries = Object.entries(errors);
    if (!entries.length) return null;
    const headingId = `${formId}-error-summary-heading`;
    return (
      <div
        id={`${formId}-error-summary`}
        ref={errorSummaryRef}
        className="notice notice--danger record-page__error-summary"
        role="alert"
        aria-labelledby={headingId}
        tabIndex={-1}
      >
        <AlertCircle size={16} aria-hidden="true" />
        <div className="record-page__error-summary-content">
          <strong id={headingId}>Review these items before saving</strong>
          <ul>
            {entries.map(([key, message]) => {
              const targetId = recordErrorTargetId(key, formId, form);
              const label = recordErrorLabel(key, schema);
              return (
                <li key={key}>
                  {targetId ? (
                    <a
                      className="text-link"
                      href={`#${targetId}`}
                      onClick={(event) => {
                        event.preventDefault();
                        focusErrorControl(targetId);
                      }}
                    >
                      {label}: {message}
                    </a>
                  ) : (
                    <span>{label}: {message}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    );
  }

  function renderField(field) {
    return (
      <FieldInput
        key={field.key}
        field={field}
        formId={formId}
        value={form.fields[field.key]}
        onChange={(value) => updateField(field.key, value)}
        error={errors['field:' + field.key]}
      />
    );
  }

  function renderTitleField() {
    const id = `${formId}-title`;
    const errorId = `${id}-error`;
    return (
      <div className="field record-page__field--wide">
        <label htmlFor={id}>Title *</label>
        <input
          id={id}
          type="text"
          value={form.title}
          onChange={(e) => setForm((prev) => ({ ...prev, title: e.target.value }))}
          required
          aria-invalid={errors.title ? 'true' : undefined}
          aria-describedby={errors.title ? errorId : undefined}
        />
        {errors.title && <p id={errorId} className="notice"><AlertCircle size={14} aria-hidden="true" /> {errors.title}</p>}
      </div>
    );
  }

  function renderStatusField() {
    const id = `${formId}-status`;
    return (
      <div className="field">
        <label htmlFor={id}>Status</label>
        <select id={id} value={form.status} onChange={(e) => setForm((prev) => ({ ...prev, status: e.target.value }))}>
          {schema.statusOptions.map((status) => (
            <option key={status} value={status}>{status}</option>
          ))}
        </select>
      </div>
    );
  }

  function renderNotesField() {
    const id = `${formId}-notes`;
    return (
      <div className="field record-page__field--wide">
        <label htmlFor={id}>Notes</label>
        <textarea id={id} rows={3} value={form.notes} onChange={(e) => setForm((prev) => ({ ...prev, notes: e.target.value }))} />
      </div>
    );
  }

  function renderModuleNotesSection() {
    const headingId = `${formId}-notes-heading`;
    const notesId = `${formId}-notes`;
    return (
      <section className="record-page__editor-section record-page__editor-section--secondary" aria-labelledby={headingId}>
        <h3 id={headingId}>Notes</h3>
        <div className="field record-page__field--wide">
          <textarea
            id={notesId}
            rows={3}
            value={form.notes}
            onChange={(e) => setForm((prev) => ({ ...prev, notes: e.target.value }))}
            aria-labelledby={headingId}
          />
        </div>
      </section>
    );
  }

  const formFooter = modalMode === 'edit' ? (
    <div className="record-page__form-footer">
      <button type="button" className="button secondary" onClick={requestClose}>Cancel</button>
      <button type="submit" form={formId} className="button primary" disabled={fileBusy}>Save</button>
    </div>
  ) : null;
  return (
    <section className="record-page">
      <SectionHeader
        section={schema.label}
        title={schema.plural}
        description={PAGE_DESCRIPTIONS[kind]}
        actions={
          <>
            <button type="button" className="button primary" onClick={openAdd}>
              <Plus size={16} /> Add {schema.label}
            </button>
            <button type="button" className="button secondary" onClick={exportListCsv} disabled={visibleRecords.length === 0}>
              <Download size={16} /> Export CSV
            </button>
            {(schema.workLinks || []).map((link) => (
              <button key={link.recipeId} type="button" className="button ghost" onClick={() => go('/work/new/' + link.recipeId)}>
                <ExternalLink size={16} /> {link.label}
              </button>
            ))}
          </>
        }
      />

      {kindRecords.length > 0 && !TABLE_RECORD_KINDS.has(kind) && (
        <div className="record-page__toolbar">
          <label className="field" htmlFor={`data-status-filter-${kind}`}>
            <span>Status</span>
            <select id={`data-status-filter-${kind}`} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value={STATUS_ALL}>All statuses</option>
              {schema.statusOptions.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </label>
        </div>
      )}

      {kindRecords.length === 0 ? (
        <div className={`empty-state record-page__empty${EMPTY_ILLUSTRATIONS[kind] ? ' record-page__empty--illustrated' : ''}`}>
          {EMPTY_ILLUSTRATIONS[kind]
            ? <img className="record-page__illustration" src={EMPTY_ILLUSTRATIONS[kind]} width="960" height="720" alt="" aria-hidden="true" decoding="async" />
            : <FileText size={24} aria-hidden="true" />}
          <h3>{schema.emptyState.title}</h3>
          {(EMPTY_ILLUSTRATIONS[kind] || kind === 'module' || kind === 'library') && <p>{schema.emptyState.body}</p>}
        </div>
      ) : TABLE_RECORD_KINDS.has(kind) ? (
        <RecordTable
          key={kind}
          kind={kind}
          records={visibleRecords}
          totalCount={kindRecords.length}
          query={query}
          status={statusFilter}
          onQueryChange={setQuery}
          onStatusChange={setStatusFilter}
          onView={openView}
          renderActions={renderRecordActions}
        />
      ) : visibleRecords.length === 0 ? (
        <div className="empty-state record-page__empty">
          <Search size={24} aria-hidden="true" />
          <h3>No records match this status</h3>
        </div>
      ) : (
        <ul className="record-page__list" aria-label={`${schema.plural} records`}>
          {visibleRecords.map((record) => (
            <li key={record.id} className="record-page__row">
              <div className="record-page__row-main">
                <div className="record-page__row-heading">
                  <button
                    id={`record-title-${record.id}`}
                    type="button"
                    className="record-table__title-button"
                    onClick={() => openView(record)}
                    aria-label={`View ${record.title || 'Untitled'}`}
                  >
                    {record.title || 'Untitled'}
                  </button>
                  <span className="badge">{record.status || 'Not specified'}</span>
                </div>
                <div className="record-page__meta">
                  {schema.summaryKeys.map((key) => {
                    const field = schema.fields.find((item) => item.key === key);
                    const value = record.fields?.[key];
                    if (!field || value === undefined || value === null || value === '') return null;
                    return <span key={key} className="chip">{field.label}: {String(value)}</span>;
                  })}
                  {kind === 'library' && record.fields?.fileId && (
                    <span className="chip">{record.fields.fileName} ({formatBytes(record.fields.fileSize)})</span>
                  )}
                  <span className="muted">Updated {formatDate(record.updatedAt)}</span>
                </div>
              </div>
              <div className="record-page__row-actions">
                {renderRecordActions(record)}
              </div>
            </li>
          ))}
        </ul>
      )}


      {modalMode && form && (
        <Modal
          title={modalMode === 'edit' ? (activeRecord ? 'Edit: ' + schema.label : 'New record: ' + schema.label) : (activeRecord.title || schema.label)}
          onClose={requestClose}
          variant="record"
          initialFocusRef={formRef}
          footer={formFooter}
        >
          {modalMode === 'view' ? (
            <div className="record-page__detail">
              <div className="form-grid record-page__detail-fields">
                <div className="field record-page__detail-field">
                  <span>Title</span>
                  <p>{activeRecord.title || 'Untitled'}</p>
                </div>
                <div className="field record-page__detail-field">
                  <span>Status</span>
                  <p><span className="badge">{activeRecord.status || 'Not specified'}</span></p>
                </div>
                {schema.fields.map((field) => (
                  <div
                    className={`field record-page__detail-field${field.type === 'textarea' ? ' record-page__detail-field--wide' : ''}`}
                    key={field.key}
                  >
                    <span>{field.label}</span>
                    <p>{formatFieldValue(field, activeRecord.fields ? activeRecord.fields[field.key] : undefined)}</p>
                  </div>
                ))}
                {kind === 'library' && (
                  <div className="field record-page__detail-field record-page__detail-field--wide">
                    <span>File</span>
                    {activeRecord.fields && activeRecord.fields.fileId ? (
                      <p>
                        {activeRecord.fields.fileName} ({formatBytes(activeRecord.fields.fileSize)}){' '}
                        <button type="button" className="button secondary" onClick={() => handleFileDownload(activeRecord.fields)}>
                          <Download size={14} /> Download
                        </button>
                      </p>
                    ) : <p className="muted">No file attached (link record)</p>}
                  </div>
                )}
                {activeRecord.notes && (
                  <div className="field record-page__detail-field record-page__detail-field--wide">
                    <span>Notes</span>
                    <p>{activeRecord.notes}</p>
                  </div>
                )}
                <div className="field record-page__detail-field record-page__detail-field--wide">
                  <span>Sources</span>
                  {activeRecord.sources && activeRecord.sources.length ? (
                    <ul className="record-page__source-links">
                      {activeRecord.sources.map((source) => (
                        <li key={source.id}>
                          {source.type === 'url' ? (
                            <a href={source.url} target="_blank" rel="noreferrer">{source.label || source.url}</a>
                          ) : (
                            <span>Library: {(libraryRecords.find((item) => item.id === source.recordId) || {}).title || 'record deleted'}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  ) : <p className="muted">No sources specified</p>}
                </div>
                <div className="field record-page__detail-field record-page__detail-field--wide">
                  <span>Record history</span>
                  <p>Created {formatDate(activeRecord.createdAt)} · Updated {formatDate(activeRecord.updatedAt)}</p>
                </div>
              </div>
              <div className="form-actions record-page__detail-actions">
                {renderDetailActions(activeRecord)}
              </div>
            </div>
          ) : (
            <form
              id={formId}
              ref={formRef}
              tabIndex={-1}
              className={`record-page__form${kind === 'module' ? ' record-page__form--module' : ''}`}
              onSubmit={handleSubmit}
              noValidate
            >
              {renderErrorSummary()}
              {kind === 'module' ? (
                <>
                  <section className="record-page__editor-section" aria-labelledby={`${formId}-basic-heading`}>
                    <h3 id={`${formId}-basic-heading`}>Basic information</h3>
                    <div className="record-page__section-fields">
                      {renderTitleField()}
                      {moduleFields.basic.map(renderField)}
                      {renderStatusField()}
                    </div>
                  </section>
                  <section className="record-page__editor-section" aria-labelledby={`${formId}-technical-heading`}>
                    <h3 id={`${formId}-technical-heading`}>Technical details</h3>
                    <div className="record-page__section-fields">
                      {moduleFields.technical.map(renderField)}
                      {moduleFields.remaining.map(renderField)}
                    </div>
                  </section>
                  <section className="record-page__editor-section" aria-labelledby={`${formId}-evidence-heading`}>
                    <h3 id={`${formId}-evidence-heading`}>Evidence and sources</h3>
                    <div className="record-page__section-fields">
                      {moduleFields.evidence.map(renderField)}
                      <SourcesEditor formId={formId} sources={form.sources} onChange={updateSources} libraryRecords={libraryRecords} errors={errors} />
                    </div>
                  </section>
                  {renderModuleNotesSection()}
                </>
              ) : (
                <>
                  {renderTitleField()}
                  {renderStatusField()}
                  {schema.fields.map(renderField)}
                  {kind === 'library' && (
                    <div className="field panel panel--quiet record-page__attachment">
                      <label htmlFor={fileInputId}>File (up to 20 MB)</label>
                      <input
                        id={fileInputId}
                        type="file"
                        onChange={handleFileChange}
                        aria-invalid={errors.libraryFile ? 'true' : undefined}
                        aria-describedby={[
                          errors.libraryFile ? fileErrorId : null,
                          errors.libraryContent ? fileContentErrorId : null,
                        ].filter(Boolean).join(' ') || undefined}
                      />
                      {fileBusy && <p className="muted">Saving file…</p>}
                      {form.fileMeta && form.fileMeta.fileId && (
                        <p className="record-page__file-summary">
                          {form.fileMeta.fileName} ({formatBytes(form.fileMeta.fileSize)}){' '}
                          <button type="button" className="button ghost" onClick={() => handleFileDownload(form.fileMeta)}><Download size={14} aria-hidden="true" /> Download</button>
                        </p>
                      )}
                      {errors.libraryFile && <p id={fileErrorId} className="notice"><AlertCircle size={14} aria-hidden="true" /> {errors.libraryFile}</p>}
                      {errors.libraryContent && <p id={fileContentErrorId} className="notice"><AlertCircle size={14} aria-hidden="true" /> {errors.libraryContent}</p>}
                    </div>
                  )}
                  {renderNotesField()}
                  <SourcesEditor formId={formId} sources={form.sources} onChange={updateSources} libraryRecords={libraryRecords} errors={errors} />
                </>
              )}
            </form>
          )}
        </Modal>
      )}
    </section>
  );
}
