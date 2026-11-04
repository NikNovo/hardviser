import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Check, ChevronDown, FolderOpen, LogOut, Plus, Settings, UserRound } from 'lucide-react';
import { useWorkspace } from './store.jsx';
import { projectDisplayLabels } from './portfolio.js';
import { SANDBOX_BILLING_ENABLED } from './billing-config.js';
import { getRagChatSession, saveSessionDisplayName, signOutSession, subscribeRagChatSession } from './rag-chat-session.js';
import SectionHeader from './SectionHeader.jsx';
import AppearanceControl from './AppearanceControl.jsx';
import './profile.css';

function canChangeProject(activeProjectId) {
  if (!activeProjectId && !document.querySelector('[data-unsaved="true"]')) return true;
  return window.confirm('Switch projects? Unsaved form edits will be discarded. Saved project data and conversation history will be kept.');
}

export function ProfileMenu() {
  const { profile, projects, activeProjectId, switchProject, go } = useWorkspace();
  const session = useSyncExternalStore(subscribeRagChatSession, getRagChatSession);
  const [open, setOpen] = useState(false);
  const root = useRef(null);
  const trigger = useRef(null);
  const current = projects.find(project => project.id === activeProjectId);
  const labels = projectDisplayLabels(projects);
  function close(restoreFocus = false) { setOpen(false); if (restoreFocus) trigger.current?.focus(); }
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector('.profile-popover a, .profile-popover button')?.focus();
    function outside(event) { if (!root.current?.contains(event.target)) setOpen(false); }
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  function menuKey(event) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const items = [...root.current.querySelectorAll('.profile-popover a, .profile-popover button:not(:disabled)')];
    if (!items.length) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : event.key === 'ArrowDown' ? (index + 1) % items.length : (index - 1 + items.length) % items.length;
    items[next]?.focus();
  }
  function choose(id) {
    if (id === activeProjectId) { close(true); return; }
    if (!canChangeProject(activeProjectId)) return;
    if (switchProject(id)) { close(true); go('/overview'); }
  }
  return <div className="profile-menu" ref={root} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <button type="button" className="profile-trigger" ref={trigger} aria-label="Open local workspace menu" aria-haspopup="dialog" aria-expanded={open} aria-controls="profile-project-menu" onClick={() => setOpen(value => !value)}>
      <span className="profile-avatar" aria-hidden="true"><FolderOpen size={16}/></span><span className="profile-trigger__copy"><strong>{current ? labels.get(current.id) : 'Local workspace'}</strong></span><ChevronDown size={14} aria-hidden="true"/>
    </button>
    {open && <div className="profile-popover" id="profile-project-menu" role="dialog" aria-label="Local workspace and server account" onKeyDown={menuKey}>
      <div className="profile-popover__identity"><strong>Server account</strong><small>{session.authenticated ? session.displayName || session.loginName || 'Signed in' : 'Not signed in'}</small>{session.authenticated && session.displayName && session.loginName && <small>{session.loginName}</small>}</div>
      {session.authenticated
        ? <button type="button" className="profile-menu-action profile-menu-action--separated" onClick={() => { close(); signOutSession(); go('/overview'); }}><LogOut size={15} aria-hidden="true"/>Sign out</button>
        : <a className="profile-menu-action profile-menu-action--separated" href="#/overview" onClick={() => close()}><UserRound size={15} aria-hidden="true"/>Sign in to server account</a>}
      {session.authenticated && session.roles?.includes('admin') && <a className="profile-menu-action" href="#/admin" onClick={() => close()}>Administration</a>}
      {SANDBOX_BILLING_ENABLED && <a className="profile-menu-action" href="#/billing" onClick={() => close()}>Sandbox billing</a>}
      <div className="profile-menu-label">Profile on this device</div>
      <p className="profile-menu-profile-name">{profile.name.trim() || 'No local name set'}</p>
      <a className="profile-menu-action" href="#/profile" onClick={() => close()}><UserRound size={15} aria-hidden="true"/>Edit profile</a>
      <div className="profile-menu-label">This account’s local projects <span>{projects.length}</span></div>
      <div className="profile-project-options">{projects.map(project => <button type="button" className="profile-project-option" key={project.id} data-active={project.id === activeProjectId} aria-current={project.id === activeProjectId ? 'true' : undefined} onClick={() => choose(project.id)}><FolderOpen size={15} aria-hidden="true"/><span><strong>{labels.get(project.id)}</strong><small>{project.stage || 'Stage not specified'}</small></span>{project.id === activeProjectId && <Check size={15} aria-label="Selected project"/>}</button>)}{!projects.length && <p className="profile-menu-empty">No projects in this browser yet.</p>}</div>
      <button type="button" className="profile-menu-action" onClick={() => { close(); if (canChangeProject(activeProjectId)) go('/new-project'); }}><Plus size={15} aria-hidden="true"/>New project…</button>
      <a className="profile-menu-action profile-menu-action--separated" href="#/settings/access" onClick={() => close()}><Settings size={15} aria-hidden="true"/>Data settings</a>
      <p className="profile-menu-footnote">Local profile and projects belong to this account and stay in this browser.</p>
    </div>}
  </div>;
}

export function ProfilePage() {
  const { profile, projects, activeProjectId, updateProfile, switchProject, notify, go, hasPreviousWorkspace } = useWorkspace();
  const session = useSyncExternalStore(subscribeRagChatSession, getRagChatSession);
  const labels = projectDisplayLabels(projects);
  const [draft, setDraft] = useState(profile);
  const [serverDisplayNameDraft, setServerDisplayNameDraft] = useState(session.displayName || '');
  const [serverNameSaving, setServerNameSaving] = useState(false);
  const [serverNameError, setServerNameError] = useState('');
  const [serverNameMessage, setServerNameMessage] = useState('');
  const serverNameRequest = useRef(null);
  useEffect(() => setDraft(profile), [profile]);
  useEffect(() => setServerDisplayNameDraft(session.displayName || ''), [session.displayName]);
  useEffect(() => () => serverNameRequest.current?.abort(), []);
  const serverNameDirty = serverDisplayNameDraft.trim() !== (session.displayName || '');
  const dirty = ['name', 'role', 'organization'].some(key => draft[key] !== profile[key]);
  function save(event) {
    event.preventDefault();
    const values = Object.fromEntries(Object.entries(draft).map(([key, value]) => [key, value.trim()]));
    if (updateProfile(values)) notify('Profile saved in this browser.');
  }
  async function saveServerDisplayName(event) {
    event.preventDefault();
    if (serverNameSaving) return;
    const value = serverDisplayNameDraft.trim();
    const length = Array.from(value).length;
    if (length > 80) {
      setServerNameError('Use 80 characters or fewer.');
      setServerNameMessage('');
      return;
    }
    if (/[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
      setServerNameError('Remove control characters from the display name.');
      setServerNameMessage('');
      return;
    }
    const controller = new AbortController();
    serverNameRequest.current?.abort();
    serverNameRequest.current = controller;
    setServerNameSaving(true);
    setServerNameError('');
    setServerNameMessage('');
    try {
      const identity = await saveSessionDisplayName(value || null, controller.signal);
      const savedName = identity?.display_name || '';
      setServerDisplayNameDraft(savedName);
      setServerNameMessage('Display name saved.');
    } catch (error) {
      if (error?.name !== 'AbortError') setServerNameError(error?.message || 'Could not save the display name. Try again.');
    } finally {
      if (serverNameRequest.current === controller) serverNameRequest.current = null;
      setServerNameSaving(false);
    }
  }
  function choose(id) {
    if (id === activeProjectId || !canChangeProject(activeProjectId)) return;
    if (switchProject(id)) go('/overview');
  }
  function signOut() {
    signOutSession();
    go('/overview');
  }
  return <>
    <SectionHeader
      section="Account & local workspace"
      title="Profile"
      description="Your server account and this account’s profile and projects stored in this browser."
    />
    {hasPreviousWorkspace && !projects.length && <div className="notice"><span>Previous shared browser data has been preserved, not assigned to this account. <a href="#/settings/access">Export and recover previous data</a>.</span></div>}
    <div className="profile-grid">
      <section className="panel">
        <div className="profile-section-heading">
          <h2>Server account</h2>
        </div>
        <div className="profile-account">
          <div className="profile-account__identity">
            <span className="profile-account__status">{session.authenticated ? 'Signed in' : 'Not signed in'}</span>
            {session.authenticated && <strong>{session.displayName || session.loginName || 'Server account'}</strong>}
            {session.authenticated && session.displayName && session.loginName && <small>{session.loginName}</small>}
          </div>
          {session.authenticated
            ? <button type="button" className="button secondary" onClick={signOut}>Sign out</button>
            : <a className="button secondary" href="#/overview">Sign in</a>}
        </div>
        {session.authenticated && <form className="profile-server-name-form" onSubmit={saveServerDisplayName} noValidate>
          <label className="field" htmlFor="profile-server-display-name">
            <span>Display name</span>
            <input
              id="profile-server-display-name"
              value={serverDisplayNameDraft}
              autoComplete="name"
              aria-invalid={serverNameError ? 'true' : undefined}
              aria-describedby={`profile-server-display-name-help${serverNameError ? ' profile-server-display-name-error' : ''}`}
              disabled={serverNameSaving}
              onChange={event => { setServerDisplayNameDraft(event.target.value); setServerNameError(''); setServerNameMessage(''); }}
            />
            <small id="profile-server-display-name-help">Shown on your server account. Leave blank to clear it; maximum 80 characters.</small>
          </label>
          {serverNameError && <p className="profile-server-name-error" id="profile-server-display-name-error" role="alert">{serverNameError}</p>}
          {serverNameMessage && <p className="profile-server-name-success" role="status" aria-live="polite">{serverNameMessage}</p>}
          <div className="form-actions">
            <button type="submit" className="button primary" disabled={!serverNameDirty || serverNameSaving} aria-busy={serverNameSaving}>
              {serverNameSaving ? 'Saving display name…' : 'Save display name'}
            </button>
          </div>
        </form>}
      </section>
      <section className="panel">
        <div className="profile-section-heading">
          <h2>Profile on this device</h2>
        </div>
        <form onSubmit={save} data-unsaved={dirty ? 'true' : undefined}>
          <div className="form-grid">
            {[['name', 'Name'], ['role', 'Role'], ['organization', 'Organization']].map(([key, label]) => (
              <label className="field" key={key}>
                <span>{label}</span>
                <input
                  value={draft[key]}
                  maxLength={120}
                  autoComplete={key === 'name' ? 'name' : key === 'organization' ? 'organization' : 'organization-title'}
                  onChange={event => setDraft({ ...draft, [key]: event.target.value })}
                />
              </label>
            ))}
          </div>
          <div className="form-actions">
            <button className="button primary" type="submit" disabled={!dirty}>Save profile</button>
          </div>
        </form>
      </section>
      <section className="panel">
        <div className="profile-section-heading">
          <h2>This account’s local projects</h2>
          <span className="muted">{projects.length}</span>
        </div>
        <div className="profile-project-list">
          {projects.map(project => (
            <div className="profile-project-row" key={project.id} data-active={project.id === activeProjectId}>
              <FolderOpen size={17} aria-hidden="true"/>
              <div>
                <strong>{labels.get(project.id)}</strong>
                <small>{project.stage || 'Stage not specified'} · {project.recordCount} records</small>
              </div>
              <button type="button" className="button secondary" disabled={project.id === activeProjectId} onClick={() => choose(project.id)}>
                {project.id === activeProjectId ? 'Current' : 'Open'}
              </button>
            </div>
          ))}
          {!projects.length && <p className="empty-state">No projects yet. <a href="#/new-project">Create a project</a></p>}
        </div>
      </section>
      <section className="panel">
        <AppearanceControl/>
      </section>
    </div>
  </>;
}
