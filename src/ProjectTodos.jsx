import { useEffect, useId, useState, useSyncExternalStore } from 'react';
import { ArrowUpRight, Check, Pencil, Plus, Trash2, X } from 'lucide-react';
import {
  createSessionTodo,
  deleteSessionTodo,
  getRagChatSession,
  refreshSessionTodos,
  selectSessionChat,
  selectSessionProject,
  subscribeRagChatSession,
  updateSessionTodo,
} from './rag-chat-session.js';
import { MAX_TODO_BYTES, MAX_TODO_CHARACTERS, unicodeCharacterCount } from './rag-chat-helpers.js';

function utf8Length(text) {
  return new TextEncoder().encode(text).byteLength;
}

function TodoTextEditor({ label, value, onChange, onCancel, onSave, busy }) {
  const helpId = useId();
  const characters = unicodeCharacterCount(value);
  const bytes = utf8Length(value);
  const invalid = !value.trim() || characters > MAX_TODO_CHARACTERS || bytes > MAX_TODO_BYTES;
  return (
    <form className="rag-todos__editor" onSubmit={event => { event.preventDefault(); if (!invalid) onSave(); }}>
      <label>
        <span>{label}</span>
        <textarea value={value} onChange={event => onChange(event.target.value)} rows={3} aria-describedby={helpId} />
      </label>
      <small id={helpId} className="rag-chat-help">
        {characters}/{MAX_TODO_CHARACTERS} characters · {bytes}/{MAX_TODO_BYTES} UTF-8 bytes
      </small>
      {invalid && <p className="rag-chat-input-error" role="alert">Enter a task within both limits.</p>}
      <div className="rag-todos__editor-actions">
        <button className="button primary" type="submit" disabled={busy || invalid}><Check size={15} aria-hidden="true" />Save task</button>
        <button className="button ghost" type="button" onClick={onCancel} disabled={busy}><X size={15} aria-hidden="true" />Cancel</button>
      </div>
    </form>
  );
}

export default function ProjectTodos({ projectId, compact = false }) {
  const session = useSyncExternalStore(subscribeRagChatSession, getRagChatSession);
  const [adding, setAdding] = useState(false);
  const [newText, setNewText] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editText, setEditText] = useState('');
  const [pendingId, setPendingId] = useState('');
  const todos = projectId ? session.todosByProject[projectId] || [] : [];
  const loading = projectId ? Boolean(session.todoLoadingByProject[projectId]) : false;
  const error = projectId ? session.todoErrorsByProject[projectId] || '' : '';

  useEffect(() => {
    if (!session.authenticated || !projectId || loading || Object.hasOwn(session.todosByProject, projectId)) return;
    void refreshSessionTodos(projectId);
  }, [session.authenticated, session.todosByProject, projectId, loading]);

  useEffect(() => {
    setAdding(false);
    setNewText('');
    setEditingId(null);
    setEditText('');
  }, [projectId, session.authenticated]);

  async function addTodo() {
    if (!newText.trim() || pendingId) return;
    setPendingId('new');
    try {
      const todo = await createSessionTodo(projectId, newText.trim());
      if (todo) {
        setNewText('');
        setAdding(false);
      }
    } catch {
      // The shared session exposes the server error beside the list.
    } finally {
      setPendingId('');
    }
  }

  async function saveEdit(todo) {
    if (pendingId) return;
    setPendingId(todo.id);
    try {
      const updated = await updateSessionTodo(projectId, todo.id, { text: editText.trim() });
      if (updated) setEditingId(null);
    } catch {
      // The shared session exposes the server error beside the list.
    } finally {
      setPendingId('');
    }
  }

  async function toggleTodo(todo) {
    if (pendingId) return;
    setPendingId(todo.id);
    try {
      await updateSessionTodo(projectId, todo.id, { completed: !todo.completed });
    } catch {
      // The shared session exposes the server error beside the list.
    } finally {
      setPendingId('');
    }
  }

  async function removeTodo(todo) {
    if (pendingId || !window.confirm(`Delete task “${todo.text}”? This cannot be undone.`)) return;
    setPendingId(todo.id);
    try {
      await deleteSessionTodo(projectId, todo.id);
    } catch {
      // The shared session exposes the server error beside the list.
    } finally {
      setPendingId('');
    }
  }

  async function openSource(todo) {
    if (!todo.source_chat_id || !todo.source_message_id) return;
    if (getRagChatSession().selectedProjectId !== projectId) await selectSessionProject(projectId);
    if (getRagChatSession().selectedChatId !== todo.source_chat_id) await selectSessionChat(todo.source_chat_id);
    window.dispatchEvent(new CustomEvent('rag-chat:jump-to-message', {
      detail: { projectId, chatId: todo.source_chat_id, messageId: todo.source_message_id },
    }));
  }

  if (!session.authenticated) {
    return <p className="rag-chat-help">Sign in to view tasks saved to your server project.</p>;
  }
  if (!projectId) {
    return <p className="rag-chat-help">Select a server project to view its tasks.</p>;
  }

  return (
    <section className={`rag-todos${compact ? ' rag-todos--compact' : ''}`} aria-label="Server project tasks">
      <div className="rag-todos__header">
        <h3>Tasks</h3>
        <button
          className="rag-chat-icon-button"
          type="button"
          aria-label={adding ? 'Cancel adding a task' : 'Add a task'}
          title={adding ? 'Cancel' : 'Add a task'}
          onClick={() => { setAdding(value => !value); setNewText(''); setEditingId(null); setEditText(''); }}
          disabled={Boolean(pendingId)}
        >
          {adding ? <X size={16} aria-hidden="true" /> : <Plus size={16} aria-hidden="true" />}
        </button>
      </div>
      {loading && <p className="rag-chat-help" role="status">Loading server tasks…</p>}
      {error && <p className="rag-chat-input-error" role="alert">{error}</p>}
      {adding && (
        <TodoTextEditor
          label="New task"
          value={newText}
          onChange={setNewText}
          onCancel={() => { setAdding(false); setNewText(''); }}
          onSave={() => void addTodo()}
          busy={pendingId === 'new'}
        />
      )}
      {!loading && todos.length === 0 && !adding && <p className="rag-chat-help">No tasks yet. Add one here or save a suggestion from an answer.</p>}
      {todos.length > 0 && (
        <ul className="rag-todos__list">
          {todos.map(todo => (
            <li className={`rag-todos__item${todo.completed ? ' is-complete' : ''}`} key={todo.id}>
              {editingId === todo.id ? (
                <TodoTextEditor
                  label="Edit task"
                  value={editText}
                  onChange={setEditText}
                  onCancel={() => setEditingId(null)}
                  onSave={() => void saveEdit(todo)}
                  busy={pendingId === todo.id}
                />
              ) : (
                <>
                  <label className="rag-todos__task">
                    <input
                      type="checkbox"
                      checked={Boolean(todo.completed)}
                      onChange={() => void toggleTodo(todo)}
                      disabled={pendingId === todo.id}
                      aria-label={`${todo.completed ? 'Reopen' : 'Complete'} task: ${todo.text}`}
                    />
                    <span>{todo.text}</span>
                  </label>
                  {todo.source_message_id && todo.source_chat_id ? (
                    <button className="rag-todos__source" type="button" onClick={() => void openSource(todo)}>
                      View answer <ArrowUpRight size={13} aria-hidden="true" />
                    </button>
                  ) : todo.source_message_id ? (
                    <small className="rag-todos__source-note">Saved from an assistant answer</small>
                  ) : null}
                  <div className="rag-todos__actions">
                    <button
                      className="rag-chat-icon-button"
                      type="button"
                      aria-label={`Edit task: ${todo.text}`}
                      onClick={() => { setEditingId(todo.id); setEditText(todo.text); setAdding(false); }}
                      disabled={Boolean(pendingId)}
                    ><Pencil size={14} aria-hidden="true" /></button>
                    <button
                      className="rag-chat-icon-button rag-chat-icon-button--danger"
                      type="button"
                      aria-label={`Delete task: ${todo.text}`}
                      onClick={() => void removeTodo(todo)}
                      disabled={Boolean(pendingId)}
                    ><Trash2 size={14} aria-hidden="true" /></button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
