import { useMemo, useState } from 'react';
import {
  Search, FileText, Users, Boxes, Cpu, ShieldCheck, ClipboardList, Factory,
  Ship, Scale, Globe2, HandCoins, Landmark, Gavel, CircuitBoard,
  Paperclip, Check, AlertTriangle, Download, ExternalLink, Trash2,
  ArrowLeft, Plus, Info, ChevronRight,
} from 'lucide-react';
import { useWorkspace } from './store.jsx';
import { downloadText } from './storage.js';
import { RECIPES, CATEGORY_ORDER } from './recipes.js';
import { SCHEMAS, formatFieldValue } from './records-schema.js';
import Modal from './Modal.jsx';
import SectionHeader from './SectionHeader.jsx';
import './work-pages.css';

const STATUS_LABELS = { draft: 'Draft', ready: 'Brief Prepared', cancelled: 'Cancelled' };
const STATUS_ORDER = ['draft', 'ready', 'cancelled'];
const OWNER_LABELS = {
  founder: 'You (self-service)',
  expert: 'External expert',
  partner: 'External partner',
};

const RECIPE_ICONS = {
  brief: FileText,
  'expert-review': Users,
  'prototype-plan': Boxes,
  electronics: CircuitBoard,
  'supplier-search': Search,
  counterparty: ShieldCheck,
  rfq: ClipboardList,
  mechanical: Factory,
  pcb: Cpu,
  china: Ship,
  patent: Scale,
  'market-review': Globe2,
  'grant-support': HandCoins,
  'investor-pack': Landmark,
  legal: Gavel,
};

// Maps recipe field -> project passport field used as an initial value suggestion.
// Only applied once, when a brand-new request is opened; never overwrites existing input.
const PREFILL = {
  brief: { objective: 'goal', constraints: 'constraints' },
  'prototype-plan': { goal: 'goal' },
  'market-review': { targetMarkets: 'markets' },
  patent: { countries: 'markets' },
  'grant-support': { amountNeeded: 'budget' },
  'investor-pack': { askAmount: 'budget' },
  'supplier-search': { budget: 'budget' },
};

function slugify(text) {
  return (text || 'request')
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[^a-zа-я0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'request';
}

function emptyInputs(recipe) {
  const out = {};
  recipe.fields.forEach((f) => {
    out[f.key] = f.type === 'checkbox' ? false : '';
  });
  return out;
}

function prefillInputs(recipe, project) {
  const inputs = emptyInputs(recipe);
  const map = PREFILL[recipe.id] || {};
  Object.entries(map).forEach(([fieldKey, projectKey]) => {
    const value = project?.[projectKey];
    if (value === undefined || value === null || value === '') return;
    inputs[fieldKey] = Array.isArray(value) ? value.join(', ') : String(value);
  });
  return inputs;
}

function missingRequiredFields(recipe, inputs) {
  return recipe.fields.filter((f) => f.required && !String(inputs?.[f.key] ?? '').trim());
}

function missingAnyFields(recipe, inputs) {
  return recipe.fields.filter((f) => f.type !== 'checkbox' && !String(inputs?.[f.key] ?? '').trim());
}

function sourceLabel(source) {
  if (!source) return null;
  if (typeof source === 'string') return source;
  if (source.type === 'library') return `Project material: ${source.recordId}`;
  return source.url ? `${source.label || 'Link'}: ${source.url}` : source.label || source.title || source.note || null;
}

function formatProjectBudget(project) {
  if (!project?.budget) return '';
  return `${project.budget}${project.currency ? ` ${project.currency}` : ''}`;
}

function buildBriefMarkdown({ recipe, project, title, inputs, attachmentRecords, progressLog }) {
  const now = new Date();
  const lines = [];
  lines.push(`# ${title || recipe.title}`);
  lines.push('');
  lines.push(
    `_Document assembled from the hardviser.com local app's deterministic template, with no AI involvement. Generated: ${now.toLocaleString('en-US')}._`
  );
  lines.push('');
  lines.push(
    '> This is a working brief/request. Sending it to an outside contractor, payment, and actual performance of the work do not happen inside the app — every external action is carried out by you manually.'
  );
  lines.push('');
  lines.push('## Project Data');
  const projectFields = [
    ['Project', project?.name],
    ['Description', project?.description],
    ['Stage', project?.stage],
    ['Product type', project?.productType],
    ['Audience', project?.audience],
    ['Target markets', Array.isArray(project?.markets) ? project.markets.join(', ') : project?.markets],
    ['Budget', formatProjectBudget(project)],
    ['Constraints', project?.constraints],
    ['Project goal', project?.goal],
  ].filter(([, value]) => value);
  if (projectFields.length) {
    projectFields.forEach(([label, value]) => lines.push(`- **${label}:** ${value}`));
  } else {
    lines.push('- The project passport has not been filled in by the founder yet.');
  }
  lines.push('');
  lines.push('## Request Parameters');
  recipe.fields.forEach((f) => {
    const raw = inputs?.[f.key];
    const value = f.type === 'checkbox' ? (raw ? 'yes' : 'no') : String(raw ?? '').trim() || null;
    lines.push(`- **${f.label}:** ${value ?? '_not specified_'}`);
  });
  lines.push('');
  lines.push('## Missing Data');
  const missing = missingAnyFields(recipe, inputs);
  if (missing.length) {
    missing.forEach((f) => lines.push(`- ${f.label}`));
  } else {
    lines.push('- No gaps found at the time of preparation.');
  }
  lines.push('');
  lines.push('## Attached Materials from the Project Library');
  if (attachmentRecords.length) {
    attachmentRecords.forEach((r) => {
      const labels = (r.sources || []).map(sourceLabel).filter(Boolean);
      const condition = labels.length ? labels.join('; ') : 'source not specified';
      lines.push(`### ${r.title || '(untitled)'} — ${SCHEMAS[r.type]?.label || r.type}`);
      lines.push(`ID: ${r.id}; updated: ${r.updatedAt || 'not specified'}; status: ${r.status || 'not specified'}`);
      for (const field of SCHEMAS[r.type]?.fields || []) lines.push(`- ${field.label}: ${formatFieldValue(field, r.fields?.[field.key])}`);
      if (r.notes) lines.push('', r.notes);
      lines.push(`Sources: ${condition}`);
      if (r.fields?.fileName) lines.push(`File: ${r.fields.fileName}. The original is not included in the Markdown — download it separately from the library.`);
      lines.push('');
    });
  } else {
    lines.push('- No materials selected.');
  }
  lines.push('');
  lines.push('## Boundaries and External Dependencies');
  lines.push(recipe.external || 'No explicit external dependencies specified; this request is informational only.');
  lines.push(`- **Responsible for delivering the result:** ${OWNER_LABELS[recipe.owner] || recipe.owner}`);
  lines.push(`- **Expected result:** ${recipe.result}`);
  if (recipe.links?.length) {
    lines.push('');
    lines.push('### Reference Links (not an integration, for reference only)');
    recipe.links.forEach((l) => lines.push(`- [${l.name}](${l.url})`));
  }
  if (progressLog?.length) {
    lines.push('');
    lines.push('## Manual Progress Notes (entered by the founder)');
    progressLog.forEach((entry) => {
      lines.push(`- ${new Date(entry.date).toLocaleString('en-US')}: ${entry.text}`);
    });
  }
  lines.push('');
  lines.push('---');
  lines.push('_hardviser.com test version. This workspace document is stored locally in this browser._');
  return lines.join('\n');
}


function FieldInput({ field, value, onChange, error }) {
  const id = `field-${field.key}`;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = error ? errorId : field.hint ? hintId : undefined;
  const commonProps = {
    id,
    value: field.type === 'checkbox' ? undefined : value ?? '',
    onChange: (e) => onChange(field.type === 'checkbox' ? e.target.checked : e.target.value),
    'aria-invalid': error ? 'true' : undefined,
    'aria-describedby': describedBy,
  };
  return (
    <div className="field">
      {field.type === 'checkbox' ? (
        <label className="work-checkbox">
          <input {...commonProps} type="checkbox" checked={!!value} />
          <span>
            {field.label}
            {field.required ? ' *' : ''}
          </span>
        </label>
      ) : (
        <>
          <label htmlFor={id}>
            {field.label}
            {field.required ? ' *' : ''}
          </label>
          {field.type === 'textarea' && <textarea rows={3} {...commonProps} />}
          {field.type === 'select' && (
            <select {...commonProps}>
              <option value="">— not selected —</option>
              {field.options.map((opt) => (
                <option key={opt} value={opt}>{opt}</option>
              ))}
            </select>
          )}
          {field.type === 'number' && <input type="number" min="0" step="any" {...commonProps} />}
          {field.type === 'date' && <input type="date" {...commonProps} />}
          {(!field.type || field.type === 'text') && <input type="text" {...commonProps} />}
        </>
      )}
      {field.hint && <small className="hint" id={hintId}>{field.hint}</small>}
      {error && (
        <p className="notice notice--danger" id={errorId} role="alert">
          <AlertTriangle size={16} strokeWidth={1.5} aria-hidden="true" /> {error}
        </p>
      )}
    </div>
  );
}

function AttachmentsPicker({ records, selectedIds, onToggle, query, onQueryChange }) {
  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    return records
      .filter((r) => r.type !== 'work')
      .filter((r) => !q || r.title?.toLowerCase().includes(q) || r.type?.toLowerCase().includes(q));
  }, [records, query]);
  return (
    <section className="work-attachments" aria-labelledby="work-attachments-title">
      <div className="work-panel-heading">
        <h2 className="work-section-title" id="work-attachments-title">
          <Paperclip size={20} strokeWidth={1.5} aria-hidden="true" /> Project records
        </h2>
      </div>
      <div className="field">
        <label htmlFor="work-attachments-search">Search project records</label>
        <input
          id="work-attachments-search"
          type="search"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          autoComplete="off"
        />
      </div>
      {candidates.length === 0 && <p className="work-empty-inline">No matching records found.</p>}
      {candidates.length > 0 && (
        <ul className="work-attachments__list" aria-label="Project records to attach">
          {candidates.map((r) => (
            <li key={r.id}>
              <label className="work-attachment">
                <input
                  type="checkbox"
                  checked={selectedIds.includes(r.id)}
                  onChange={() => onToggle(r.id)}
                />
                <span className="work-attachment__content">
                  <strong>{r.title || '(untitled)'}</strong>
                  <small>{SCHEMAS[r.type]?.label || r.type}</small>
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}


function RequestForm({ recipe, existingRecord, project, records, onSaveDraft, onPrepare, onCancel }) {
  const [title, setTitle] = useState(
    existingRecord?.title || `${recipe.title} — ${project?.name || 'project'}`
  );
  const [inputs, setInputs] = useState(
    existingRecord?.fields?.inputs || prefillInputs(recipe, project)
  );
  const [attachmentIds, setAttachmentIds] = useState(existingRecord?.fields?.attachments || []);
  const [attachQuery, setAttachQuery] = useState('');
  const [errors, setErrors] = useState({});
  const [reviewText, setReviewText] = useState(null);

  const attachmentRecords = useMemo(
    () => records.filter((r) => attachmentIds.includes(r.id)),
    [records, attachmentIds]
  );
  const missingFields = useMemo(() => missingAnyFields(recipe, inputs), [recipe, inputs]);

  function setField(key, value) {
    setInputs((prev) => ({ ...prev, [key]: value }));
  }
  function toggleAttachment(id) {
    setAttachmentIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function handleSaveDraft() {
    onSaveDraft({ title, inputs, attachmentIds });
  }

  function handlePrepareClick() {
    const missing = missingRequiredFields(recipe, inputs);
    const map = {};
    missing.forEach((field) => { map[field.key] = 'This required field is not filled in'; });
    recipe.fields.filter(field => field.type === 'number' && String(inputs[field.key] ?? '').trim()).forEach(field => {
      if (!Number.isFinite(Number(inputs[field.key])) || Number(inputs[field.key]) <= 0) map[field.key] = 'Quantity must be greater than zero';
    });
    if (Object.keys(map).length) { setErrors(map); return; }
    setErrors({});
    const text = buildBriefMarkdown({
      recipe,
      project,
      title,
      inputs,
      attachmentRecords,
      progressLog: existingRecord?.fields?.progressLog || [],
    });
    setReviewText(text);
  }

  function confirmPrepare() {
    onPrepare({ title, inputs, attachmentIds, briefText: reviewText });
    setReviewText(null);
  }

  return (
    <div className="panel work-form">
      <div className="field">
        <label htmlFor="work-title">Request title</label>
        <input id="work-title" type="text" value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <p className={recipe.id === 'brief' ? 'notice' : 'notice notice--warning'}>
        <Info size={16} strokeWidth={1.5} aria-hidden="true" /> Compiled from your inputs; not an AI or expert review. {recipe.external || 'Nothing is sent to suppliers or experts.'}
      </p>

      {missingFields.length > 0 && (
        <p className="notice notice--warning">
          <AlertTriangle size={16} strokeWidth={1.5} aria-hidden="true" /> Not filled in: {missingFields.map((f) => f.label).join(', ')}
        </p>
      )}

      <div className="form-grid">
        {recipe.fields.map((f) => (
          <FieldInput
            key={f.key}
            field={f}
            value={inputs[f.key]}
            onChange={(v) => setField(f.key, v)}
            error={errors[f.key]}
          />
        ))}
      </div>

      <AttachmentsPicker
        records={records}
        selectedIds={attachmentIds}
        onToggle={toggleAttachment}
        query={attachQuery}
        onQueryChange={setAttachQuery}
      />

      <div className="form-actions">
        {onCancel && (
          <button type="button" className="button ghost" onClick={onCancel}>
            <ArrowLeft size={20} strokeWidth={1.5} aria-hidden="true" /> Back
          </button>
        )}
        <button type="button" className="button secondary" onClick={handleSaveDraft}>
          Save Draft
        </button>
        <button type="button" className="button primary" onClick={handlePrepareClick}>
          Prepare Brief
        </button>
      </div>

      {reviewText !== null && (
        <Modal title="Review the Brief Before Saving" onClose={() => setReviewText(null)} labelId="review-brief-title">
          <pre className="work-brief-preview">{reviewText}</pre>
          <div className="form-actions">
            <button type="button" className="button ghost" onClick={() => setReviewText(null)}>
              Back to Editing
            </button>
            <button type="button" className="button primary" onClick={confirmPrepare}>
              <Check size={20} strokeWidth={1.5} aria-hidden="true" /> Confirm & Save
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function CatalogListItem({ recipe, onOpen }) {
  const Icon = RECIPE_ICONS[recipe.id] || FileText;
  return (
    <button type="button" className="work-row work-row--catalog" onClick={() => onOpen(recipe.id)}>
      <span className="work-row__icon">
        <Icon size={20} strokeWidth={1.5} aria-hidden="true" />
      </span>
      <span className="work-row__content">
        <strong>{recipe.title}</strong>
        <span className="work-row__description">{recipe.description}</span>
        <span className="work-row__meta">{OWNER_LABELS[recipe.owner] || recipe.owner}</span>
      </span>
      <ChevronRight size={20} strokeWidth={1.5} aria-hidden="true" />
    </button>
  );
}

function WorkListItem({ record, recipe, onOpen }) {
  const Icon = recipe ? RECIPE_ICONS[recipe.id] || FileText : FileText;
  const updatedAt = record.updatedAt || record.createdAt;
  return (
    <button type="button" className="work-row" onClick={() => onOpen(record.id)}>
      <span className="work-row__icon">
        <Icon size={20} strokeWidth={1.5} aria-hidden="true" />
      </span>
      <span className="work-row__content">
        <strong>{record.title}</strong>
        <span className="work-row__meta">
          <span>{recipe ? recipe.title : 'Recipe not found in catalog'}</span>
          <span>
            Updated <time className="work-mono" dateTime={updatedAt}>{new Date(updatedAt).toLocaleDateString('en-US')}</time>
          </span>
        </span>
      </span>
      <ChevronRight size={20} strokeWidth={1.5} aria-hidden="true" />
    </button>
  );
}

function WorkRequestsPage({ records, go }) {
  const workRecords = useMemo(() => records.filter((r) => r.type === 'work'), [records]);
  const statusGroups = useMemo(() => {
    const groups = new Map(STATUS_ORDER.map((status) => [status, []]));
    const otherGroups = new Map();
    workRecords.forEach((record) => {
      const status = record.status || 'draft';
      const destination = groups.has(status) ? groups : otherGroups;
      if (!destination.has(status)) destination.set(status, []);
      destination.get(status).push(record);
    });
    return [
      ...STATUS_ORDER.map((status) => ({ status, records: groups.get(status) })),
      ...Array.from(otherGroups, ([status, statusRecords]) => ({ status, records: statusRecords })),
    ].filter((group) => group.records.length > 0);
  }, [workRecords]);

  return (
    <div className="work-page">
      <SectionHeader
        section="Work"
        title="Requests"
        actions={
          <button type="button" className="button primary" onClick={() => go('/work/catalog')}>
            <Plus size={20} strokeWidth={1.5} aria-hidden="true" /> New request
          </button>
        }
      />
      {workRecords.length === 0 ? (
        <div className="empty-state work-empty">
          <FileText size={20} strokeWidth={1.5} aria-hidden="true" />
          <h2>No requests yet</h2>
        </div>
      ) : (
        <div className="work-list-groups">
          {statusGroups.map(({ status, records: groupedRecords }) => {
            const headingId = `work-status-${String(status).toLowerCase().replace(/[^a-z0-9_-]+/g, '-')}`;
            return (
              <section className="work-list-group" key={status} aria-labelledby={headingId}>
                <div className="work-group-heading">
                  <h2 id={headingId}>{STATUS_LABELS[status] || status}</h2>
                  <span className="work-count">{groupedRecords.length}</span>
                </div>
                <ul className="work-row-list">
                  {groupedRecords.map((record) => (
                    <li key={record.id}>
                      <WorkListItem
                        record={record}
                        recipe={RECIPES.find((item) => item.id === record.fields?.recipeId)}
                        onOpen={(id) => go(`/work/${id}`)}
                      />
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

function WorkCatalogPage({ go }) {
  const byCategory = useMemo(() => {
    const groups = {};
    RECIPES.forEach((r) => {
      groups[r.category] = groups[r.category] || [];
      groups[r.category].push(r);
    });
    return groups;
  }, []);

  return (
    <div className="work-page">
      <SectionHeader
        section="Work"
        title="Service catalog"
      />
      <div className="work-catalog-groups">
        {CATEGORY_ORDER.filter((cat) => byCategory[cat]?.length).map((cat) => {
          const headingId = `work-category-${cat.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
          return (
            <section className="work-category" key={cat} aria-labelledby={headingId}>
              <div className="work-group-heading">
                <h2 id={headingId}>{cat}</h2>
              </div>
              <ul className="work-row-list">
                {byCategory[cat].map((recipe) => (
                  <li key={recipe.id}>
                    <CatalogListItem recipe={recipe} onOpen={(id) => go(`/work/new/${id}`)} />
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}


function saveDocumentAndLink({ saveRecord, notify, recipe, project, title, inputs, attachmentIds, attachmentRecords, briefText, workRecord, go, isNewWork }) {
  const now = new Date();
  const savedWork = saveRecord({
    ...(workRecord || {}),
    id: workRecord?.id,
    type: 'work',
    title,
    notes: `Request based on the "${recipe.title}" recipe. Status is updated manually.`,
    status: 'ready',
    fields: {
      recipeId: recipe.id,
      inputs,
      attachments: attachmentIds,
      progressLog: workRecord?.fields?.progressLog || [],
      documentId: workRecord?.fields?.documentId,
      briefText,
      preparedAt: now.toISOString(),
    },
    sources: workRecord?.sources || [],
  });
  if (!savedWork) {
    notify('Could not save the request.');
    return;
  }
  const savedDoc = saveRecord({
    id: workRecord?.fields?.documentId,
    type: 'document',
    title: `Brief: ${title}`,
    notes: briefText,
    status: 'In review',
    fields: { sourceWorkId: savedWork.id, recipeId: recipe.id, docType: 'Brief', docDate: now.toISOString().slice(0, 10) },
    sources: (recipe.links || []).map((link) => ({ id: crypto.randomUUID(), type: 'url', url: link.url, label: link.name })),
  });
  let complete = Boolean(savedDoc);
  if (savedDoc && savedDoc.id !== workRecord?.fields?.documentId) {
    complete = Boolean(saveRecord({ ...savedWork, fields: { ...savedWork.fields, documentId: savedDoc.id } }));
  }
  downloadText(briefText, `${slugify(title)}.md`);
  notify(complete ? `Brief prepared and saved: ${title}` : 'The brief was downloaded, but saving the document or the link was not completed. Check the library.');
  if (isNewWork) go(`/work/${savedWork.id}`);
}

function WorkFormPage({ recipeId, project, records, saveRecord, notify, go }) {
  const recipe = RECIPES.find((r) => r.id === recipeId);
  if (!recipe) {
    return (
      <div className="panel work-page">
        <p className="notice notice--warning" role="alert">
          <AlertTriangle size={16} strokeWidth={1.5} aria-hidden="true" /> Recipe "{recipeId}" not found in the catalog.
        </p>
        <button type="button" className="button secondary" onClick={() => go('/work/catalog')}>
          <ArrowLeft size={20} strokeWidth={1.5} aria-hidden="true" /> To Catalog
        </button>
      </div>
    );
  }
  return (
    <div className="work-page">
      <SectionHeader section={recipe.category} title={recipe.title} description={recipe.description} />
      <RequestForm
        recipe={recipe}
        existingRecord={null}
        project={project}
        records={records}
        onCancel={() => go('/work/catalog')}
        onSaveDraft={({ title, inputs, attachmentIds }) => {
          const saved = saveRecord({
            type: 'work',
            title,
            notes: `Request based on the "${recipe.title}" recipe. Status is updated manually.`,
            status: 'draft',
            fields: { recipeId: recipe.id, inputs, attachments: attachmentIds, progressLog: [] },
            sources: [],
          });
          if (saved) {
            notify(`Draft saved: ${title}`);
            go(`/work/${saved.id}`);
          } else {
            notify('Could not save the draft.');
          }
        }}
        onPrepare={({ title, inputs, attachmentIds, briefText }) => {
          const attachmentRecords = records.filter((r) => attachmentIds.includes(r.id));
          saveDocumentAndLink({
            saveRecord, notify, recipe, project, title, inputs, attachmentIds, attachmentRecords,
            briefText, workRecord: null, go, isNewWork: true,
          });
        }}
      />
    </div>
  );
}

function RawInputsView({ record }) {
  const entries = Object.entries(record.fields?.inputs || {});
  return (
    <div className="panel work-raw-inputs">
      <p className="notice notice--warning" role="alert">
        <AlertTriangle size={16} strokeWidth={1.5} aria-hidden="true" /> The recipe for this request was not found in the current catalog. The request data has been saved and is available below in its raw form.
      </p>
      <div className="table-wrap">
        <table className="work-raw-inputs__table">
          <tbody>
            {entries.map(([k, v]) => (
              <tr key={k}>
                <td className="work-raw-inputs__key">{k}</td>
                <td>{String(v)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function WorkDetailPage({ workId, project, records, saveRecord, removeRecord, notify, go }) {
  const record = records.find((r) => r.id === workId && r.type === 'work');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [noteText, setNoteText] = useState('');

  if (!record) {
    return (
      <div className="panel work-page">
        <p className="notice notice--warning" role="alert">
          <AlertTriangle size={16} strokeWidth={1.5} aria-hidden="true" /> Request not found. It may have been deleted.
        </p>
        <button type="button" className="button secondary" onClick={() => go('/work')}>
          <ArrowLeft size={20} strokeWidth={1.5} aria-hidden="true" /> To Request List
        </button>
      </div>
    );
  }

  const recipe = RECIPES.find((r) => r.id === record.fields?.recipeId);

  function handleStatusChange(status) {
    const saved = saveRecord({ ...record, status });
    if (saved) notify(`Status updated: ${STATUS_LABELS[status]}`);
    else notify('Could not update the status.');
  }

  function handleAddNote() {
    const text = noteText.trim();
    if (!text) return;
    const progressLog = [...(record.fields?.progressLog || []), { date: new Date().toISOString(), text }];
    const saved = saveRecord({ ...record, fields: { ...record.fields, progressLog } });
    if (saved) {
      notify('Note added.');
      setNoteText('');
    } else {
      notify('Could not save the note.');
    }
  }

  function handleQuickDownload() {
    if (record.status === 'ready' && record.fields?.briefText) {
      downloadText(record.fields.briefText, `${slugify(record.title)}.md`);
      return;
    }
    if (!recipe) {
      notify('Download unavailable: recipe not found in the catalog.');
      return;
    }
    const attachmentRecords = records.filter((r) => (record.fields?.attachments || []).includes(r.id));
    const text = buildBriefMarkdown({
      recipe,
      project,
      title: record.title,
      inputs: record.fields?.inputs || {},
      attachmentRecords,
      progressLog: record.fields?.progressLog || [],
    });
    downloadText(text, `${slugify(record.title)}.md`);
  }

  function handleDelete() {
    const ok = removeRecord(record.id);
    setConfirmDelete(false);
    if (ok) {
      notify('Request deleted.');
      go('/work');
    } else {
      notify('Could not delete the request.');
    }
  }

  return (
    <div className="work-page">
      <div className="work-detail__heading">
        <SectionHeader
          section={recipe ? recipe.category : 'Request'}
          title={record.title}
          actions={
            <>
              <button type="button" className="button primary" onClick={handleQuickDownload} disabled={!recipe}>
                <Download size={20} strokeWidth={1.5} aria-hidden="true" /> Download Markdown
              </button>
              <button type="button" className="button ghost" onClick={() => go('/work')}>
                <ArrowLeft size={20} strokeWidth={1.5} aria-hidden="true" /> Back to List
              </button>
              <button type="button" className="button danger" onClick={() => setConfirmDelete(true)}>
                <Trash2 size={20} strokeWidth={1.5} aria-hidden="true" /> Delete
              </button>
            </>
          }
        />
        <dl className="work-detail__timestamps">
          <div>
            <dt>Created</dt>
            <dd><time dateTime={record.createdAt}>{new Date(record.createdAt).toLocaleString('en-US')}</time></dd>
          </div>
          <div>
            <dt>Last revised</dt>
            <dd><time dateTime={record.updatedAt || record.createdAt}>{new Date(record.updatedAt || record.createdAt).toLocaleString('en-US')}</time></dd>
          </div>
        </dl>
      </div>

      <section className="panel work-status-panel" aria-labelledby="work-status-heading">
        <div className="work-panel-heading">
          <h2 className="work-section-title" id="work-status-heading">Status</h2>
        </div>
        <div className="work-status-options" role="group" aria-label="Request status">
          {STATUS_ORDER.map((status) => (
            <button
              key={status}
              type="button"
              className="work-status-option"
              onClick={() => handleStatusChange(status)}
              aria-pressed={record.status === status}
            >
              {record.status === status && <Check size={16} strokeWidth={1.5} aria-hidden="true" />}
              <span>{STATUS_LABELS[status]}</span>
            </button>
          ))}
        </div>
      </section>

      {recipe ? (
        <RequestForm
          recipe={recipe}
          existingRecord={record}
          project={project}
          records={records}
          onSaveDraft={({ title, inputs, attachmentIds }) => {
            const linkedDocument = records.find(item => item.id === record.fields?.documentId);
            if (linkedDocument && !saveRecord({ ...linkedDocument, status: 'Outdated' })) {
              notify('Could not update the status of the previous brief. Changes to the request were not saved.');
              return;
            }
            const saved = saveRecord({
              ...record,
              title,
              status: 'draft',
              fields: { ...record.fields, inputs, attachments: attachmentIds, briefText: '', preparedAt: '' },
            });
            notify(saved ? `Changes saved: ${title}` : 'Could not save the changes.');
          }}
          onPrepare={({ title, inputs, attachmentIds, briefText }) => {
            const attachmentRecords = records.filter((r) => attachmentIds.includes(r.id));
            saveDocumentAndLink({
              saveRecord, notify, recipe, project, title, inputs, attachmentIds, attachmentRecords,
              briefText, workRecord: record, go, isNewWork: false,
            });
          }}
        />
      ) : (
        <RawInputsView record={record} />
      )}

      <section className="panel work-progress-panel" aria-labelledby="work-progress-heading">
        <div className="work-panel-heading">
          <h2 className="work-section-title" id="work-progress-heading">Progress log</h2>
        </div>
        {(record.fields?.progressLog || []).length === 0 && (
          <p className="work-empty-inline">No notes yet.</p>
        )}
        {(record.fields?.progressLog || []).length > 0 && (
          <ol className="work-note-list">
            {record.fields.progressLog.map((entry, i) => (
              <li key={i}>
                <time className="work-mono" dateTime={entry.date}>{new Date(entry.date).toLocaleString('en-US')}</time>
                <p>{entry.text}</p>
              </li>
            ))}
          </ol>
        )}
        <div className="form-grid">
          <div className="field wide">
            <label htmlFor="progress-note">New note</label>
            <textarea id="progress-note" rows={2} value={noteText} onChange={(e) => setNoteText(e.target.value)} />
          </div>
        </div>
        <div className="form-actions">
          <button type="button" className="button secondary" onClick={handleAddNote}>
            <Plus size={20} strokeWidth={1.5} aria-hidden="true" /> Add Note
          </button>
        </div>
      </section>

      {recipe?.links?.length > 0 && (
        <section className="panel work-references" aria-labelledby="work-references-heading">
          <div className="work-panel-heading">
            <h2 className="work-section-title" id="work-references-heading">Reference links</h2>
          </div>
          <ul className="work-reference-list">
            {recipe.links.map((link) => (
              <li key={link.url}>
                <a href={link.url} target="_blank" rel="noreferrer">
                  <span>{link.name}</span>
                  <ExternalLink size={16} strokeWidth={1.5} aria-hidden="true" />
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      {confirmDelete && (
        <Modal title="Delete Request?" onClose={() => setConfirmDelete(false)} labelId="delete-work-title">
          <p>The request "{record.title}" will be deleted from this browser. Prepared documents and attached materials will remain in the project; they can be deleted separately.</p>
          <div className="form-actions">
            <button type="button" className="button ghost" onClick={() => setConfirmDelete(false)}>Cancel</button>
            <button type="button" className="button danger" onClick={handleDelete}>
              <Trash2 size={20} strokeWidth={1.5} aria-hidden="true" /> Delete
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

export default function WorkPage({ recipeId, workId, view = 'requests' }) {
  const { project, records, saveRecord, removeRecord, notify, go } = useWorkspace();

  if (workId) {
    return (
      <WorkDetailPage
        workId={workId}
        project={project}
        records={records}
        saveRecord={saveRecord}
        removeRecord={removeRecord}
        notify={notify}
        go={go}
      />
    );
  }

  if (recipeId) {
    return (
      <WorkFormPage
        recipeId={recipeId}
        project={project}
        records={records}
        saveRecord={saveRecord}
        notify={notify}
        go={go}
      />
    );
  }

  return view === 'catalog' ? <WorkCatalogPage go={go} /> : <WorkRequestsPage records={records} go={go} />;
}
