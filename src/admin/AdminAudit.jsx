import { useEffect, useRef, useState } from 'react';
import { runAdminOperation } from '../rag-chat-session.js';
import SectionHeader from '../SectionHeader.jsx';
import {
  adminErrorText,
  adminUserHref,
  auditStatus,
  formatAdminDateTime,
  isAbortError,
  isForbiddenError,
  roleNames,
} from './admin-helpers.js';

const PAGE_SIZE = 50;
const EMPTY_FILTERS = { operation: '', actor_id: '', target_user_id: '', since: '', until: '' };

function auditArgs(filters, cursor) {
  return {
    ...(filters.target_user_id ? { target_user_id: filters.target_user_id } : {}),
    ...(filters.actor_id ? { actor_id: filters.actor_id } : {}),
    ...(filters.operation ? { operation: filters.operation } : {}),
    ...(filters.since ? { since: filters.since } : {}),
    ...(filters.until ? { until: filters.until } : {}),
    ...(cursor ? { cursor } : {}),
    limit: PAGE_SIZE,
  };
}

function displayActor(entry) {
  if (entry.actor_label) return entry.actor_label;
  return entry.actor_kind === 'operator' ? 'Operator' : entry.actor_id || 'Unknown actor';
}

function AuditState({ state, retry }) {
  if (state.phase === 'loading') return <p className="admin-state" role="status" aria-live="polite">Loading audit log…</p>;
  if (state.phase === 'error') return <div className="notice notice--danger admin-state" role="alert"><p>{state.error}</p><button type="button" className="button secondary" onClick={retry}>Retry</button></div>;
  return null;
}

function ChangeState({ title, state }) {
  return <section className="admin-audit-change" aria-label={title}>
    <h3>{title}</h3>
    <dl>
      <div><dt>Roles</dt><dd>{roleNames(state.roles)}</dd></div>
      <div><dt>Status</dt><dd><span className={`admin-status${state.disabled_at ? ' is-disabled' : ''}`}>{auditStatus(state)}</span></dd></div>
      <div><dt>Revision</dt><dd><code>{state.revision}</code></dd></div>
    </dl>
  </section>;
}

function AuditEntry({ entry }) {
  return <li className="admin-audit-entry">
    <h2 className="sr-only">Audit entry: {entry.operation}</h2>
    <header className="admin-audit-entry__header">
      <div className="admin-audit-actor">
        <span className="admin-audit-label">Actor</span>
        <strong>{displayActor(entry)}</strong>
        {entry.actor_id && entry.actor_label && <small>Actor ID: <code>{entry.actor_id}</code></small>}
        <small>{entry.actor_kind === 'operator' ? 'Operator action' : 'Server account action'}</small>
      </div>
      <time dateTime={entry.created_at}>{formatAdminDateTime(entry.created_at)}</time>
    </header>
    <dl className="admin-audit-meta">
      <div><dt>Operation</dt><dd><code>{entry.operation}</code></dd></div>
      <div><dt>Target account</dt><dd><a href={adminUserHref(entry.target_user_id)}><code>{entry.target_user_id}</code></a></dd></div>
    </dl>
    <div className="admin-audit-compare">
      <ChangeState title="Before" state={entry.before}/>
      <ChangeState title="After" state={entry.after}/>
    </div>
    <div className="admin-audit-reason">
      <h3>Reason</h3>
      <p>{entry.reason}</p>
    </div>
  </li>;
}

export default function AdminAudit({ onForbidden }) {
  const [draft, setDraft] = useState(EMPTY_FILTERS);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [rangeError, setRangeError] = useState('');
  const [page, setPage] = useState(null);
  const [listState, setListState] = useState({ key: '', phase: 'loading', error: '' });
  const [loadingMoreKey, setLoadingMoreKey] = useState('');
  const [moreError, setMoreError] = useState('');
  const [retryCount, setRetryCount] = useState(0);
  const requestId = useRef(0);
  const moreController = useRef(null);
  const key = JSON.stringify(filters);

  useEffect(() => {
    const controller = new AbortController();
    const currentRequest = ++requestId.current;
    setListState({ key, phase: 'loading', error: '' });
    setMoreError('');
    setLoadingMoreKey('');
    void runAdminOperation('admin.audit.list', auditArgs(filters), controller.signal).then(result => {
      if (currentRequest !== requestId.current) return;
      setPage({ key, items: result.items, nextCursor: result.next_cursor });
      setListState({ key, phase: 'ready', error: '' });
    }).catch(error => {
      if (isAbortError(error) || currentRequest !== requestId.current) return;
      if (isForbiddenError(error)) {
        onForbidden();
        return;
      }
      setListState({ key, phase: 'error', error: adminErrorText(error, 'Could not load the audit log. Try again.') });
    });
    return () => {
      controller.abort();
      moreController.current?.abort();
    };
  }, [key, retryCount, onForbidden]);

  const currentPage = page?.key === key ? page : null;
  const currentState = listState.key === key ? listState : { phase: 'loading', error: '' };
  const loadingMore = loadingMoreKey === key;

  function changeDraft(name, value) {
    setDraft(previous => ({ ...previous, [name]: value }));
    setRangeError('');
  }

  function applyFilters(event) {
    event.preventDefault();
    const sinceDate = draft.since ? new Date(draft.since) : null;
    const untilDate = draft.until ? new Date(draft.until) : null;
    if (sinceDate && Number.isNaN(sinceDate.getTime())) {
      setRangeError('Enter a valid start date and time.');
      return;
    }
    if (untilDate && Number.isNaN(untilDate.getTime())) {
      setRangeError('Enter a valid end date and time.');
      return;
    }
    if (sinceDate && untilDate && sinceDate > untilDate) {
      setRangeError('The start date must be on or before the end date.');
      return;
    }
    setRangeError('');
    setFilters({
      operation: draft.operation,
      actor_id: draft.actor_id.trim(),
      target_user_id: draft.target_user_id.trim(),
      since: sinceDate ? sinceDate.toISOString() : '',
      until: untilDate ? untilDate.toISOString() : '',
    });
    setRetryCount(value => value + 1);
  }

  async function loadMore() {
    if (!currentPage?.nextCursor || loadingMore) return;
    const controller = new AbortController();
    moreController.current = controller;
    const currentRequest = ++requestId.current;
    setLoadingMoreKey(key);
    setMoreError('');
    try {
      const result = await runAdminOperation('admin.audit.list', auditArgs(filters, currentPage.nextCursor), controller.signal);
      if (currentRequest !== requestId.current) return;
      setPage(previous => previous?.key === key
        ? { key, items: [...previous.items, ...result.items], nextCursor: result.next_cursor }
        : previous);
    } catch (error) {
      if (isAbortError(error) || currentRequest !== requestId.current) return;
      if (isForbiddenError(error)) {
        onForbidden();
        return;
      }
      setMoreError(adminErrorText(error, 'Could not load more audit entries. Try again.'));
    } finally {
      if (currentRequest === requestId.current) setLoadingMoreKey('');
      if (moreController.current === controller) moreController.current = null;
    }
  }

  return <>
    <SectionHeader
      section="Administration"
      title="Audit log"
      description="Account access changes, newest first. Audit entries cannot be edited or deleted."
    />
    <section className="panel admin-audit" aria-label="Audit log">
      <form className="admin-filter-form admin-audit-filters" onSubmit={applyFilters}>
        <label className="field" htmlFor="admin-audit-operation">
          <span>Operation</span>
          <select id="admin-audit-operation" value={draft.operation} onChange={event => changeDraft('operation', event.target.value)}>
            <option value="">All operations</option>
            <option value="admin.users.roles.set">Set user roles</option>
            <option value="admin.users.status.set">Set account status</option>
            <option value="admin.bootstrap">Bootstrap administrator</option>
          </select>
        </label>
        <label className="field" htmlFor="admin-audit-actor">
          <span>Actor ID</span>
          <input id="admin-audit-actor" value={draft.actor_id} onChange={event => changeDraft('actor_id', event.target.value)}/>
        </label>
        <label className="field" htmlFor="admin-audit-target">
          <span>Target user ID</span>
          <input id="admin-audit-target" value={draft.target_user_id} onChange={event => changeDraft('target_user_id', event.target.value)}/>
        </label>
        <label className="field" htmlFor="admin-audit-since">
          <span>Since</span>
          <input id="admin-audit-since" type="datetime-local" value={draft.since} onChange={event => changeDraft('since', event.target.value)} aria-invalid={rangeError ? 'true' : undefined} aria-describedby={`admin-audit-since-help${rangeError ? ' admin-audit-range-error' : ''}`}/>
          <small id="admin-audit-since-help">Your local time.</small>
        </label>
        <label className="field" htmlFor="admin-audit-until">
          <span>Until</span>
          <input id="admin-audit-until" type="datetime-local" value={draft.until} onChange={event => changeDraft('until', event.target.value)} aria-invalid={rangeError ? 'true' : undefined} aria-describedby={`admin-audit-until-help${rangeError ? ' admin-audit-range-error' : ''}`}/>
          <small id="admin-audit-until-help">Your local time.</small>
        </label>
        <button type="submit" className="button primary">Apply filters</button>
        {rangeError && <p className="admin-action-error admin-audit-range-error" id="admin-audit-range-error" role="alert">{rangeError}</p>}
      </form>

      <AuditState state={currentState} retry={() => setRetryCount(value => value + 1)}/>
      {currentState.phase === 'ready' && currentPage && <>
        {currentPage.items.length === 0
          ? <div className="empty-state admin-state"><h2>No audit events found</h2><p>No account changes match these filters. Adjust the filters to search again.</p></div>
          : <ol className="admin-audit-list" aria-label="Audit entries">{currentPage.items.map(entry => <AuditEntry key={entry.id} entry={entry}/>)}</ol>}
        {currentPage.nextCursor && <div className="admin-load-more">
          {moreError && <p className="notice notice--danger" role="alert">{moreError}</p>}
          <button type="button" className="button secondary" onClick={() => void loadMore()} disabled={loadingMore} aria-busy={loadingMore}>
            {loadingMore ? 'Loading more entries…' : 'Load more'}
          </button>
        </div>}
      </>}
    </section>
  </>;
}
