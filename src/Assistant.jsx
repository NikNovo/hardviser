import React, { useState } from 'react';
import { ArrowUpRight, Download, FileText } from 'lucide-react';
import { useWorkspace } from './store.jsx';
import { SCHEMAS } from './records-schema.js';
import { recordLink } from './GlobalSearch.jsx';
import SectionHeader from './SectionHeader.jsx';
import './project-pages.css';

export function MemoryPage() {
  const { records, go } = useWorkspace();
  const [filter, setFilter] = useState('all');
  const found = records.filter(record => filter === 'all' || record.type === filter);
  return (
    <div className="project-memory">
      <SectionHeader section="Knowledge" title="Project memory" description="Records saved in this local project." />
      <div className="filter-bar project-memory__toolbar">
        <label className="field">
          <span>Record type</span>
          <select value={filter} onChange={event => setFilter(event.target.value)}>
            <option value="all">All records</option>
            {Object.entries(SCHEMAS).map(([kind, schema]) => <option key={kind} value={kind}>{schema.plural}</option>)}
            <option value="work">Requests</option>
          </select>
        </label>
        <span className="muted" aria-live="polite">{found.length} {found.length === 1 ? 'record' : 'records'}</span>
      </div>
      <div className="record-list">
        {found.map(record => <button className="recent-row memory-row" key={record.id} onClick={() => go(recordLink(record))}>
          <FileText size={16} />
          <span>
            <strong>{record.title}</strong>
            <small>{SCHEMAS[record.type]?.label || 'Request'} · {new Date(record.updatedAt).toLocaleDateString('en-US')} · {(record.sources || []).length} linked sources</small>
          </span>
          <span className="badge">{({ draft: 'Draft', ready: 'Brief prepared', cancelled: 'Cancelled' })[record.status] || record.status}</span>
          <ArrowUpRight size={14} />
        </button>)}
      </div>
      {!found.length && (
        <section className="panel empty-state compact memory-empty">
          <h2>{records.length ? 'No records match this filter' : 'No records yet'}</h2>
          <p>{records.length ? 'Choose another record type to see more.' : 'Records saved here will appear in Project memory.'}</p>
          {!records.length && <button type="button" className="button primary" onClick={() => go('/library/evidence')}>Open evidence records <ArrowUpRight size={16} /></button>}
        </section>
      )}
    </div>
  );
}
export function SettingsPage() {
  const { activeProjectId, projects, exportProject, exportWorkspace, importProject, hasPreviousWorkspace, exportPreviousWorkspace, listPreviousFiles, exportPreviousFile } = useWorkspace();
  const [importing, setImporting] = useState(false);
  const [previousFiles, setPreviousFiles] = useState(null);
  async function restore(event) {
    const input = event.currentTarget;
    const file = input.files[0];
    if (!file || importing) return;
    setImporting(true);
    try { await importProject(file); } finally { input.value = ''; setImporting(false); }
  }
  return (
    <div className="project-settings">
      <SectionHeader section="Account" title="Data settings" description="Local backups belong to the signed-in account on this browser; server data is stored separately." />
      <section className="panel project-settings__panel">
        <header className="project-settings__heading"><h2>Backups</h2></header>
        <p>A project backup includes its brief, records, requests, readiness answers and historical local conversation. A workspace backup includes this account’s local profile and all {projects.length} local projects. These backups do not include server chats or server files. JSON is the backup format; working documents have separate Markdown/CSV exports.</p>
        <div className="notice project-settings__notice">Original uploaded file bytes are not included. Download originals separately from Files &amp; links before clearing site data or moving to another browser.</div>
        <div className="form-actions">
          <button className="button primary" onClick={exportWorkspace}><Download size={16} />Export workspace</button>
          <button className="button secondary" onClick={exportProject} disabled={!activeProjectId}>Export current project</button>
        </div>
      </section>
      {hasPreviousWorkspace && <section className="panel project-settings__panel">
        <header className="project-settings__heading"><h2>Previous shared browser data</h2></header>
        <p>Older data was not associated with an account. It has been preserved, but is not loaded into any account automatically. Export it, sign in to its intended account, then import the JSON. Download and reattach original files separately.</p>
        <div className="form-actions">
          <button type="button" className="button secondary" onClick={exportPreviousWorkspace}><Download size={16}/>Export previous workspace</button>
          <button type="button" className="button secondary" onClick={() => setPreviousFiles(listPreviousFiles())}>Show previous attachments</button>
        </div>
        {previousFiles && (previousFiles.length
          ? <ul>{previousFiles.map(file => <li key={file.fileId}><button type="button" className="button ghost" onClick={() => void exportPreviousFile(file)}><Download size={16}/>{file.fileName}</button></li>)}</ul>
          : <p className="muted">No previous attachment references were found.</p>)}
      </section>}
      <section className="panel project-settings__panel">
        <header className="project-settings__heading"><h2>Import or restore</h2></header>
        <p>A single-project backup is imported as a new, separate project. Its file references must be reattached to originals. A whole-workspace backup replaces only the current account’s local profile and projects after confirmation; other accounts are unchanged.</p>
        <label className="field">
          <span>{importing ? 'Importing backup…' : 'Choose a JSON backup'}</span>
          <input type="file" accept="application/json,.json" disabled={importing} onChange={restore} />
        </label>
        <p className="muted">Export a workspace backup first if you need to keep the current data.</p>
      </section>
      <section className="panel project-settings__panel">
        <header className="project-settings__heading"><h2>AI and external services</h2></header>
        <p>AI Cofounder uses your server project's brief, conversation and selected file excerpts through the authenticated Severus service and Meta MUSE Standard. Technical questions also search the knowledge base. Errors are shown explicitly; there are no simulated AI responses.</p>
        <p>This test has no team collaboration controls, electronic signatures or automatic supplier orders. Exporting a brief does not send it to a third party.</p>
        <p>Server data and the active local workspace are scoped to your signed-in account. Local data is not encrypted or synced between browsers: people with access to this browser’s storage may still read it. Use separate browser profiles on shared devices. Do not use the public test as a secure trade-secret vault.</p>
        <a className="text-link" href="#/legal/privacy">Read the privacy notice</a>
      </section>
    </div>
  );
}
