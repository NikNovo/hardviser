import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { FilePlus2, Search, Upload } from 'lucide-react';
import Modal from './Modal.jsx';
import {
  MAX_TODO_BYTES,
  MAX_TODO_CHARACTERS,
  FILE_INPUT_ACCEPT,
  SUPPORTED_FILE_FORMAT_GROUPS,
  classifyFileExtension,
  fileStatusHint,
  formatFileSize,
  truncateTodoText,
  unicodeCharacterCount,
} from './rag-chat-helpers.js';
import {
  addSessionMention,
  attachSessionFile,
  getRagChatSession,
  refreshSessionFiles,
  subscribeRagChatSession,
  uploadSessionFile,
} from './rag-chat-session.js';
import { browseFiles } from './rag-chat-api.js';

export const BRIEF_FIELDS = [
  ['description', 'What are you building?'],
  ['audience', 'Who is it for?'],
  ['markets', 'Target markets'],
  ['team', 'Team and capabilities'],
  ['goal', 'Next milestone'],
  ['notes', 'Existing context / notes'],
];
const MAX_BRIEF_BYTES = 8192;

function utf8Length(text) {
  return new TextEncoder().encode(text).byteLength;
}

export function currentBriefField(project, field) {
  const fields = project?.brief_fields;
  if (fields && typeof fields === 'object' && Object.keys(fields).length > 0) {
    return Object.hasOwn(fields, field) && typeof fields[field] === 'string' ? fields[field] : '';
  }
  if (field === 'notes' && typeof project?.brief_text === 'string') return project.brief_text;
  return '';
}

export function AddTodoDialog({ project, initialText, sourceMessageId, onSave, onClose }) {
  const initial = useMemo(() => truncateTodoText(initialText), [initialText]);
  const [text, setText] = useState(initial.text);
  const [acknowledged, setAcknowledged] = useState(!initial.truncated);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const characters = unicodeCharacterCount(text);
  const bytes = utf8Length(text);
  const invalid = !text.trim() || characters > MAX_TODO_CHARACTERS || bytes > MAX_TODO_BYTES;
  const warningId = 'rag-chat-todo-source-warning';
  const taskInput = useRef(null);

  async function submit(event) {
    event.preventDefault();
    if (saving || invalid || !acknowledged) return;
    setSaving(true);
    setError('');
    try {
      const saved = await onSave(text.trim(), sourceMessageId);
      if (!saved) throw new Error('The server did not confirm that this task was saved. Try again.');
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'The task could not be saved. Try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title="Add to server tasks" onClose={onClose} initialFocusRef={taskInput}>
      <form className="rag-dialog-form" onSubmit={submit}>
        <p className="muted">This task will be saved to <strong>{project?.name || 'the selected server project'}</strong> and linked to this assistant answer.</p>
        {initial.truncated && (
          <div className="rag-dialog-warning" id={warningId}>
            The answer exceeds task limits. This editable field starts with the longest prefix that fits within 2,000 Unicode characters and 8,000 UTF-8 bytes; review it before saving.
          </div>
        )}
        <label className="field">
          <span>Task *</span>
          <textarea ref={taskInput} value={text} onChange={event => setText(event.target.value)} rows={7} required aria-describedby={initial.truncated ? `${warningId} rag-chat-todo-count` : 'rag-chat-todo-count'} />
        </label>
        <small id="rag-chat-todo-count" className="rag-chat-help">{characters}/{MAX_TODO_CHARACTERS} characters · {bytes}/{MAX_TODO_BYTES} UTF-8 bytes</small>
        {invalid && <p className="rag-chat-input-error" role="alert">Enter a task within both limits before saving.</p>}
        {initial.truncated && (
          <label className="rag-dialog-acknowledgement">
            <input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} />
            <span>I reviewed the shortened task text.</span>
          </label>
        )}
        {error && <p className="rag-chat-input-error" role="alert">{error}</p>}
        <div className="form-actions">
          <button className="button primary" type="submit" disabled={saving || invalid || !acknowledged}>{saving ? 'Saving…' : 'Save task'}</button>
          <button className="button ghost" type="button" onClick={onClose} disabled={saving}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}

export function SaveBriefDialog({ project, initialText, sourceMessageId, onSave, onClose }) {
  const briefFieldSelect = useRef(null);
  const [field, setField] = useState('notes');
  const [text, setText] = useState(initialText || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const expectedText = currentBriefField(project, field);
  const fieldBytes = utf8Length(text);
  const fieldTooLarge = fieldBytes > MAX_BRIEF_BYTES;

  async function submit(event) {
    event.preventDefault();
    if (saving || fieldTooLarge) return;
    setSaving(true);
    setError('');
    try {
      const saved = await onSave(field, text, expectedText, sourceMessageId);
      if (!saved) throw new Error('The server did not confirm that the brief was saved. Try again.');
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'The project brief could not be saved. Try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title="Review project brief change" onClose={onClose} initialFocusRef={briefFieldSelect}>
      <form className="rag-dialog-form" onSubmit={submit}>
        <p className="muted">Server brief for <strong>{project?.name || 'the selected server project'}</strong>. Saved only when you confirm.</p>
        <label className="field">
          <span>Server brief field</span>
          <select ref={briefFieldSelect} value={field} onChange={event => setField(event.target.value)}>
            {BRIEF_FIELDS.map(([key, label]) => <option value={key} key={key}>{label}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Proposed content</span>
          <textarea value={text} onChange={event => setText(event.target.value)} rows={8} aria-describedby="rag-chat-brief-limit" />
        </label>
        <small id="rag-chat-brief-limit" className="rag-chat-help">{fieldBytes} UTF-8 bytes · whole brief limit 8,192 bytes</small>
        {fieldTooLarge && <p className="rag-chat-input-error" role="alert">This field alone exceeds the complete brief limit. Shorten it before saving.</p>}
        <section className="rag-brief-preview" aria-label="Review saved and proposed content">
          <div><h3>Currently saved</h3><pre>{expectedText || 'This field is empty.'}</pre></div>
          <div><h3>After confirmation</h3><pre>{text || 'This field will be empty.'}</pre></div>
        </section>
        {error && <p className="rag-chat-input-error" role="alert">{error}</p>}
        <div className="form-actions">
          <button className="button primary" type="submit" disabled={saving || fieldTooLarge}>{saving ? 'Saving…' : 'Save to server brief'}</button>
          <button className="button ghost" type="button" onClick={onClose} disabled={saving}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}

function fileKindLabel(file) {
  const kind = file.kind || classifyFileExtension(file.name);
  return SUPPORTED_FILE_FORMAT_GROUPS.find(group => group.kind === kind)?.label || 'File';
}

export function FileBrowserDialog({ projectId, projectName, onAttached, onClose }) {
  const session = useSyncExternalStore(subscribeRagChatSession, getRagChatSession);
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [query, setQuery] = useState('');
  const [projectFilter, setProjectFilter] = useState('all');
  const [attachingId, setAttachingId] = useState('');
  const [uploading, setUploading] = useState(false);
  const [pendingUploadId, setPendingUploadId] = useState('');
  const [message, setMessage] = useState('');
  const [actionError, setActionError] = useState('');
  const fileInput = useRef(null);
  const searchInput = useRef(null);
  const onAttachedRef = useRef(onAttached);
  const onCloseRef = useRef(onClose);
  onAttachedRef.current = onAttached;
  onCloseRef.current = onClose;
  const uploadProgress = session.uploads.filter(upload => upload.projectId === projectId);

  const loadFiles = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const result = await browseFiles();
      setFiles(Array.isArray(result) ? result : []);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Your files could not be loaded. Try again.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadFiles(); }, [loadFiles]);

  useEffect(() => {
    if (!pendingUploadId) return;
    const uploaded = session.files.find(file => file.id === pendingUploadId);
    if (!uploaded) return;
    if (uploaded.status === 'ready') {
      if (!addSessionMention(uploaded)) {
        setActionError('The file is ready, but the next question already has 10 mentions. Remove one mention and select the file from your project list.');
        setPendingUploadId('');
        return;
      }
      onAttachedRef.current(uploaded);
      onCloseRef.current();
    } else if (uploaded.status === 'failed') {
      setActionError(`${uploaded.name} could not be prepared: ${fileStatusHint(uploaded)}.`);
      setPendingUploadId('');
    }
  }, [session.files, pendingUploadId]);

  const projects = useMemo(() => {
    const byId = new Map();
    for (const file of files) {
      if (file.project_id) byId.set(file.project_id, file.project_name || 'Unnamed project');
    }
    return [...byId.entries()].map(([id, name]) => ({ id, name }));
  }, [files]);

  const visibleFiles = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return files
      .filter(file => projectFilter === 'all' || file.project_id === projectFilter)
      .filter(file => !needle || `${file.name} ${file.project_name || ''} ${file.status || ''}`.toLocaleLowerCase().includes(needle))
      .map(file => {
        const current = session.selectedProjectId === projectId && file.project_id === projectId
          ? session.files.find(item => item.id === file.id)
          : null;
        return current ? { ...file, ...current } : file;
      });
  }, [files, projectFilter, projectId, query, session.files, session.selectedProjectId]);

  async function attach(file) {
    if (attachingId || uploading) return;
    if (session.selectedProjectId !== projectId) {
      setActionError('The selected server project changed. Close this browser and reopen it from the current chat.');
      return;
    }
    if (file.status !== 'ready') {
      setActionError('Only ready files can be attached to a question.');
      return;
    }
    if (!session.mentions.some(mention => mention.id === file.id) && session.mentions.length >= 10) {
      setActionError('A question can mention up to 10 files. Remove one mention before attaching another.');
      return;
    }
    setAttachingId(file.id);
    setActionError('');
    try {
      const attached = await attachSessionFile(projectId, file.id);
      if (!attached || attached.status !== 'ready') throw new Error('The file could not be attached to the selected project.');
      if (!session.mentions.some(mention => mention.id === attached.id) && session.mentions.length >= 10) {
        throw new Error('The file was imported, but this question already has 10 mentions. Remove one mention and select the file again.');
      }
      onAttachedRef.current(attached);
      onCloseRef.current();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'The file could not be attached. Check the project quota and try again.');
    } finally {
      setAttachingId('');
    }
  }

  async function upload(file) {
    if (!file) return;
    setActionError('');
    setMessage('');
    if (session.selectedProjectId !== projectId) {
      setActionError('The selected server project changed. Close this browser and reopen it from the current chat.');
    } else if (!classifyFileExtension(file.name)) {
      setActionError('Unsupported file type. See the supported formats in the project file list.');
    } else if (file.size > 10 * 1024 * 1024) {
      setActionError('New uploads must be 10 MiB or smaller.');
    } else if (session.mentions.length < 10) {
      setUploading(true);
      try {
        const mime = typeof file.type === 'string' && file.type.length <= 100 ? file.type : '';
        const result = await uploadSessionFile(file, mime);
        if (!result?.id) {
          const uploads = getRagChatSession().uploads;
          let uploadError = '';
          for (let index = uploads.length - 1; index >= 0; index -= 1) {
            const upload = uploads[index];
            if (upload.name === file.name && upload.projectId === projectId && upload.status === 'error') {
              uploadError = upload.error;
              break;
            }
          }
          throw new Error(uploadError || 'The upload did not finish. Check the project quota and try again.');
        }
        const refreshed = await refreshSessionFiles(projectId);
        const uploaded = Array.isArray(refreshed) ? refreshed.find(item => item.id === result.id) || result : result;
        setFiles(current => [uploaded, ...current.filter(item => item.id !== uploaded.id)]);
        if (uploaded.status === 'ready') {
          if (!addSessionMention(uploaded)) {
            setActionError('The file is ready, but the next question already has 10 mentions. Remove one mention and select the file from your project list.');
          } else {
            onAttachedRef.current(uploaded);
            onCloseRef.current();
          }
        } else if (uploaded.status === 'failed') {
          throw new Error(`${uploaded.name} could not be prepared: ${fileStatusHint(uploaded)}.`);
        } else {
          setPendingUploadId(uploaded.id);
          setMessage(`“${uploaded.name}” uploaded to ${projectName}. Keep this browser open to add it to your next question when processing finishes; after closing, reopen Browse and attach it once ready.`);
        }
      } catch (error) {
        setActionError(error instanceof Error ? error.message : 'The upload failed. Check your project quota and try again.');
      } finally {
        setUploading(false);
      }
    } else {
      setActionError('A question can mention up to 10 files. Remove one mention before uploading an attachment.');
    }
    if (fileInput.current) fileInput.current.value = '';
  }

  return (
    <Modal title="Attach a project file" onClose={onClose} initialFocusRef={searchInput}>
      <div className="rag-file-browser">
        <p className="muted">Choose a file for <strong>{projectName}</strong>.</p>
        <div className="rag-file-browser__upload">
          <button className="button secondary" type="button" onClick={() => fileInput.current?.click()} disabled={uploading} aria-describedby="rag-file-upload-limit">
            <Upload size={15} aria-hidden="true" />{uploading ? 'Uploading…' : 'Upload new file'}
          </button>
          <input
            ref={fileInput}
            className="rag-file-browser__input"
            type="file"
            accept={FILE_INPUT_ACCEPT}
            aria-label="Choose a file to upload to this server project"
            disabled={uploading}
            hidden
            tabIndex={-1}
            aria-hidden="true"
            onChange={event => void upload(event.target.files?.[0])}
          />
          <small id="rag-file-upload-limit">New uploads up to 10 MiB.</small>
        </div>
        {uploadProgress.map(upload => {
          const percent = upload.total ? Math.round((upload.loaded / upload.total) * 100) : 100;
          return (
            <div className={`rag-chat-upload-progress${upload.status === 'error' ? ' has-error' : ''}`} key={upload.id}>
              <div><span>{upload.name}</span><span>{upload.status === 'error' ? 'Failed' : `${percent}%`}</span></div>
              <progress max={upload.total || 1} value={upload.loaded} aria-label={`Upload progress for ${upload.name}`} />
              {upload.error && <p role="alert">{upload.error}</p>}
            </div>
          );
        })}
        {message && <p className="rag-chat-pending-note" role="status">{message}</p>}
        {actionError && <p className="rag-chat-input-error" role="alert">{actionError}</p>}
        <div className="rag-file-browser__filters">
          <label className="rag-file-browser__search">
            <span className="sr-only">Search files</span>
            <Search size={16} aria-hidden="true" />
            <input ref={searchInput} type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search files or projects" />
          </label>
          <label className="rag-chat-field-label" htmlFor="rag-file-project-filter">Project</label>
          <select id="rag-file-project-filter" value={projectFilter} onChange={event => setProjectFilter(event.target.value)}>
            <option value="all">All projects</option>
            {projects.map(project => <option value={project.id} key={project.id}>{project.name}</option>)}
          </select>
        </div>
        {loading ? <p className="rag-chat-pending" role="status">Loading your files…</p> : loadError ? (
          <div className="rag-file-browser__error" role="alert">
            <p>{loadError}</p>
            <button className="button secondary" type="button" onClick={() => void loadFiles()}>Retry</button>
          </div>
        ) : visibleFiles.length === 0 ? (
          <p className="rag-chat-help">{files.length ? 'No files match these filters.' : 'No files are available in your server projects yet.'}</p>
        ) : (
          <ul className="rag-file-browser__list">
            {visibleFiles.map(file => {
              const inTargetProject = file.project_id === projectId;
              const status = fileStatusHint(file);
              return (
                <li className="rag-file-browser__item" key={file.id}>
                  <div className="rag-file-browser__details">
                    <strong title={file.name}>{file.name}</strong>
                    <small>{file.project_name || 'Unknown project'} · {formatFileSize(file.size_bytes)} · {fileKindLabel(file)}</small>
                    <small>{status}</small>
                  </div>
                  <button className="button secondary" type="button" onClick={() => void attach(file)} disabled={file.status !== 'ready' || Boolean(attachingId) || uploading}>
                    <FilePlus2 size={14} aria-hidden="true" />
                    {attachingId === file.id ? 'Importing…' : inTargetProject ? 'Add to next question' : 'Import & attach'}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Modal>
  );
}
