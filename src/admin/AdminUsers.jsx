import { useEffect, useRef, useState } from 'react';
import { getRagChatSession, runAdminOperation } from '../rag-chat-session.js';
import Modal from '../Modal.jsx';
import SectionHeader from '../SectionHeader.jsx';
import {
  adminErrorText,
  adminUserHref,
  auditStatus,
  formatAdminDateTime,
  isAbortError,
  isAmbiguousError,
  isForbiddenError,
  isNotFoundError,
  roleNames,
  userStatus,
} from './admin-helpers.js';

const PAGE_SIZE = 50;
// Keep unresolved outcomes across SPA route unmounts, scoped to actor and target.
const pendingReconciliations = new Set();

function UserList({ onForbidden }) {
  const [criteria, setCriteria] = useState({ query: '', role: '', status: '' });
  const [queryDraft, setQueryDraft] = useState('');
  const [retryCount, setRetryCount] = useState(0);
  const [page, setPage] = useState(null);
  const [listState, setListState] = useState({ key: '', phase: 'loading', error: '' });
  const [loadingMoreKey, setLoadingMoreKey] = useState('');
  const [moreError, setMoreError] = useState(null);
  const requestId = useRef(0);
  const moreController = useRef(null);
  const key = JSON.stringify(criteria);

  useEffect(() => {
    const controller = new AbortController();
    const currentRequest = ++requestId.current;
    setListState({ key, phase: 'loading', error: '' });
    setMoreError(null);
    setLoadingMoreKey('');
    const args = {
      ...(criteria.query ? { query: criteria.query } : {}),
      ...(criteria.role ? { role: criteria.role } : {}),
      ...(criteria.status ? { status: criteria.status } : {}),
      limit: PAGE_SIZE,
    };
    void runAdminOperation('admin.users.list', args, controller.signal).then(result => {
      if (currentRequest !== requestId.current) return;
      setPage({ key, items: result.items, nextCursor: result.next_cursor });
      setListState({ key, phase: 'ready', error: '' });
    }).catch(error => {
      if (isAbortError(error) || currentRequest !== requestId.current) return;
      if (isForbiddenError(error)) {
        onForbidden();
        return;
      }
      setListState({ key, phase: 'error', error: adminErrorText(error, 'Could not load accounts. Try again.') });
    });
    return () => {
      controller.abort();
      moreController.current?.abort();
    };
  }, [key, retryCount, onForbidden]);

  const currentPage = page?.key === key ? page : null;
  const currentState = listState.key === key ? listState : { phase: 'loading', error: '' };
  const loadingMore = loadingMoreKey === key;

  function changeFilter(name, value) {
    setCriteria(previous => ({ ...previous, [name]: value }));
  }

  async function loadMore() {
    if (!currentPage?.nextCursor || loadingMore) return;
    const controller = new AbortController();
    moreController.current = controller;
    const currentRequest = ++requestId.current;
    setLoadingMoreKey(key);
    setMoreError(null);
    try {
      const result = await runAdminOperation('admin.users.list', {
        ...(criteria.query ? { query: criteria.query } : {}),
        ...(criteria.role ? { role: criteria.role } : {}),
        ...(criteria.status ? { status: criteria.status } : {}),
        cursor: currentPage.nextCursor,
        limit: PAGE_SIZE,
      }, controller.signal);
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
      setMoreError(adminErrorText(error, 'Could not load more accounts. Try again.'));
    } finally {
      if (currentRequest === requestId.current) setLoadingMoreKey('');
      if (moreController.current === controller) moreController.current = null;
    }
  }

  return <>
    <SectionHeader
      section="Administration"
      title="Users"
      description="Find an account and review its server roles and status."
    />
    <section className="panel admin-users" aria-label="User accounts">
      <form className="admin-filter-form admin-user-filters" onSubmit={event => {
        event.preventDefault();
        setCriteria(previous => ({ ...previous, query: queryDraft.trim() }));
        setRetryCount(value => value + 1);
      }}>
        <label className="field admin-user-search" htmlFor="admin-user-query">
          <span>Search email or login</span>
          <input id="admin-user-query" type="search" maxLength={254} value={queryDraft} onChange={event => setQueryDraft(event.target.value)}/>
        </label>
        <label className="field" htmlFor="admin-user-role">
          <span>Role</span>
          <select id="admin-user-role" value={criteria.role} onChange={event => changeFilter('role', event.target.value)}>
            <option value="">Any role</option>
            <option value="admin">Admin</option>
            <option value="expert">Expert</option>
          </select>
        </label>
        <label className="field" htmlFor="admin-user-status">
          <span>Status</span>
          <select id="admin-user-status" value={criteria.status} onChange={event => changeFilter('status', event.target.value)}>
            <option value="">Any status</option>
            <option value="active">Active</option>
            <option value="disabled">Disabled</option>
          </select>
        </label>
        <button type="submit" className="button primary">Search</button>
      </form>

      {currentState.phase === 'loading' && <p className="admin-state" role="status" aria-live="polite">Loading user accounts…</p>}
      {currentState.phase === 'error' && <div className="notice notice--danger admin-state" role="alert">
        <p>{currentState.error}</p>
        <button type="button" className="button secondary" onClick={() => setRetryCount(value => value + 1)}>Retry</button>
      </div>}
      {currentState.phase === 'ready' && currentPage && <>
        {currentPage.items.length === 0
          ? <div className="empty-state admin-state"><h2>No accounts found</h2><p>Try a different email, login, role, or status filter.</p></div>
          : <div className="admin-table-wrap">
            <table className="admin-table admin-users-table">
              <caption className="sr-only">User accounts matching the current search and filters</caption>
              <thead><tr><th scope="col">Account</th><th scope="col">Roles</th><th scope="col">Status</th><th scope="col">Created</th><th scope="col"><span className="sr-only">Details</span></th></tr></thead>
              <tbody>{currentPage.items.map(user => <tr key={user.id}>
                <td data-label="Account">
                  <div className="admin-user-identity">
                    <strong>{user.display_name || <span className="muted">No display name</span>}</strong>
                    <span>{user.email || 'Email not provided'}</span>
                    <small>Login: {user.login}</small>
                  </div>
                </td>
                <td data-label="Roles"><span className="admin-role-list">{roleNames(user.roles)}</span></td>
                <td data-label="Status"><span className={`admin-status${user.disabled_at ? ' is-disabled' : ''}`}>{userStatus(user)}</span></td>
                <td data-label="Created"><time dateTime={user.created_at}>{formatAdminDateTime(user.created_at)}</time></td>
                <td data-label="Details"><a className="button secondary admin-user-detail-link" href={adminUserHref(user.id)}>View details</a></td>
              </tr>)}</tbody>
            </table>
          </div>}
        {currentPage.nextCursor && <div className="admin-load-more">
          {moreError && <p className="notice notice--danger" role="alert">{moreError}</p>}
          <button type="button" className="button secondary" onClick={() => void loadMore()} disabled={loadingMore} aria-busy={loadingMore}>
            {loadingMore ? 'Loading more accounts…' : 'Load more'}
          </button>
        </div>}
      </>}
    </section>
  </>;
}

function AccountDetails({ userId, onForbidden, mutationsAllowed }) {
  const recoveryKey = `${getRagChatSession().userId}:${userId}`;
  const [detail, setDetail] = useState(null);
  const [rolesDraft, setRolesDraft] = useState([]);
  const [detailPhase, setDetailPhase] = useState('loading');
  const [detailError, setDetailError] = useState('');
  const [detailRetry, setDetailRetry] = useState(0);
  const [detailNotice, setDetailNotice] = useState(null);
  const [roleError, setRoleError] = useState('');
  const [statusError, setStatusError] = useState('');
  const [success, setSuccess] = useState('');
  const [confirmation, setConfirmation] = useState(null);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState('');
  const [mutationBusy, setMutationBusy] = useState(false);
  const [recoveryAudit, setRecoveryAudit] = useState(null);
  const [reconciliationRequired, setReconciliationRequired] = useState(() => pendingReconciliations.has(recoveryKey));
  const reasonInput = useRef(null);
  const uncertainRecoveryFocus = useRef(false);
  const recoveryController = useRef(null);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      recoveryController.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!mutationBusy && uncertainRecoveryFocus.current) {
      uncertainRecoveryFocus.current = false;
      document.getElementById('admin-main')?.focus({ preventScroll: true });
    }
  }, [mutationBusy]);

  useEffect(() => {
    setDetail(null);
    setDetailPhase('loading');
    setDetailError('');
    if (pendingReconciliations.has(recoveryKey)) {
      void recheckAfterUncertainResponse();
      return () => recoveryController.current?.abort();
    }
    const controller = new AbortController();
    void runAdminOperation('admin.users.get', { user_id: userId }, controller.signal).then(user => {
      setDetail(user);
      setRolesDraft([...user.roles]);
      setDetailPhase('ready');
    }).catch(error => {
      if (isAbortError(error)) return;
      if (isForbiddenError(error)) {
        onForbidden();
        return;
      }
      if (isNotFoundError(error)) {
        setDetailPhase('not-found');
        return;
      }
      setDetailError(adminErrorText(error, 'Could not load this account. Try again.'));
      setDetailPhase('error');
    });
    return () => controller.abort();
  }, [userId, detailRetry, onForbidden, recoveryKey]);

  const hasRoleChanges = Boolean(detail) && (rolesDraft.length !== detail.roles.length || rolesDraft.some((role, index) => role !== detail.roles[index]));

  function openRoleConfirmation() {
    if (mutationBusy || !mutationsAllowed || reconciliationRequired) return;
    setRoleError('');
    setSuccess('');
    setConfirmation({ kind: 'roles', roles: [...rolesDraft].sort() });
    setReason('');
    setReasonError('');
  }

  function openStatusConfirmation() {
    if (mutationBusy || !mutationsAllowed || reconciliationRequired) return;
    setStatusError('');
    setSuccess('');
    setConfirmation({ kind: 'status', disabled: !detail.disabled_at });
    setReason('');
    setReasonError('');
  }

  function changeRole(role, checked) {
    setRolesDraft(previous => [...new Set(checked ? [...previous, role] : previous.filter(item => item !== role))].sort());
    setRoleError('');
    setSuccess('');
  }

  function reloadAfterStale() {
    setDetailNotice({
      kind: 'warning',
      text: 'Another administrator changed this account. The latest account state is being loaded; review it before making another change.',
    });
    setDetail(null);
    setDetailPhase('loading');
    setRecoveryAudit(null);
    setDetailRetry(value => value + 1);
  }

  async function recheckAfterUncertainResponse() {
    pendingReconciliations.add(recoveryKey);
    if (!mounted.current) return;
    recoveryController.current?.abort();
    const controller = new AbortController();
    recoveryController.current = controller;
    setReconciliationRequired(true);
    setDetailNotice({
      kind: 'warning',
      text: 'The change response was not received. The mutation was not retried; the account and its audit history are being re-read so you can review the result.',
    });
    setRecoveryAudit({ phase: 'loading', items: [] });
    const results = await Promise.allSettled([
      runAdminOperation('admin.users.get', { user_id: userId }, controller.signal),
      runAdminOperation('admin.audit.list', { target_user_id: userId, limit: 5 }, controller.signal),
    ]);
    if (controller.signal.aborted || !mounted.current) return;
    if (recoveryController.current === controller) recoveryController.current = null;
    const failed = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (failed.some(isForbiddenError) || failed.some(error => error?.status === 401)) {
      onForbidden();
      return;
    }
    const accountResult = results[0];
    const auditResult = results[1];
    if (accountResult.status === 'fulfilled') {
      setDetail(accountResult.value);
      setRolesDraft([...accountResult.value.roles]);
      setDetailPhase('ready');
      setDetailError('');
    } else if (isNotFoundError(accountResult.reason)) {
      setDetail(null);
      setDetailPhase('not-found');
    } else {
      setDetailError(adminErrorText(accountResult.reason, 'The account could not be re-read. Retry the account and audit recheck before taking another action.'));
      setDetailPhase('error');
    }
    if (auditResult.status === 'fulfilled') {
      setRecoveryAudit({ phase: 'ready', items: auditResult.value.items });
      setDetailNotice({
        kind: 'warning',
        text: 'The change response was not received and no mutation was retried. The account and audit history were re-read; review both before taking another action.',
      });
    } else {
      setRecoveryAudit({ phase: 'error', items: [], error: adminErrorText(auditResult.reason, 'The audit history could not be re-read.') });
      setDetailNotice({
        kind: 'warning',
        text: 'The change response was not received and no mutation was retried. The latest account state is shown, but both account and audit history must be re-read before taking another action.',
      });
    }
    if (failed.length === 0) {
      pendingReconciliations.delete(recoveryKey);
      setReconciliationRequired(false);
    }
  }

  async function confirmChange(event) {
    event.preventDefault();
    if (!confirmation || mutationBusy || !mutationsAllowed || reconciliationRequired) return;
    const trimmedReason = reason.trim();
    const reasonLength = Array.from(trimmedReason).length;
    if (!reasonLength || reasonLength > 500) {
      setReasonError(!reasonLength ? 'Enter a reason for this change.' : 'Keep the reason within 500 characters.');
      reasonInput.current?.focus();
      return;
    }
    const pendingChange = confirmation;
    const isRoleChange = pendingChange.kind === 'roles';
    if (isRoleChange) setRoleError('');
    else setStatusError('');
    setSuccess('');
    setMutationBusy(true);
    try {
      const operation = isRoleChange ? 'admin.users.roles.set' : 'admin.users.status.set';
      const args = isRoleChange
        ? { user_id: detail.id, roles: pendingChange.roles, expected_revision: detail.revision, reason: trimmedReason }
        : { user_id: detail.id, disabled: pendingChange.disabled, expected_revision: detail.revision, reason: trimmedReason };
      const saved = await runAdminOperation(operation, args);
      setDetail(saved);
      setRolesDraft([...saved.roles]);
      setDetailNotice(null);
      setRecoveryAudit(null);
      setConfirmation(null);
      setReason('');
      setReasonError('');
      setSuccess(isRoleChange ? 'Roles saved.' : `Account ${pendingChange.disabled ? 'disabled' : 'enabled'}.`);
    } catch (error) {
      if (isAbortError(error)) return;
      if (isForbiddenError(error)) {
        onForbidden();
        return;
      }
      setReason('');
      setReasonError('');
      if (isAmbiguousError(error)) {
        uncertainRecoveryFocus.current = true;
        await recheckAfterUncertainResponse();
        setConfirmation(null);
      } else {
        setConfirmation(null);
        if (error?.code === 'stale_user') {
          setRoleError('');
          setStatusError('');
          reloadAfterStale();
        } else if (error?.code === 'self_protection' || error?.code === 'last_admin') {
          const message = adminErrorText(error);
          if (isRoleChange) setRoleError(message);
          else setStatusError(message);
        } else {
          const message = adminErrorText(error, isRoleChange ? 'Could not save roles. Review the account and try again.' : 'Could not change account status. Review the account and try again.');
          if (isRoleChange) setRoleError(message);
          else setStatusError(message);
        }
      }
    } finally {
      setMutationBusy(false);
    }
  }

  const closeConfirmation = () => {
    if (mutationBusy) return;
    setConfirmation(null);
    setReason('');
    setReasonError('');
  };

  if (detailPhase === 'loading') return <div className="admin-page">
    <SectionHeader section="Users" title="Account details" description="Review the server account and its access."/>
    <p className="admin-state" role="status" aria-live="polite">Loading account details…</p>
  </div>;
  if (detailPhase === 'not-found') return <div className="admin-page">
    <SectionHeader section="Users" title="Account not found" actions={<a className="button secondary" href="#/admin/users">Back to users</a>}/>
    <div className="notice notice--warning" role="status"><p>This account is no longer available. Return to the user list to search again.</p></div>
  </div>;
  if (detailPhase === 'error') return <div className="admin-page">
    <SectionHeader section="Users" title="Account details" actions={<a className="button secondary" href="#/admin/users">Back to users</a>}/>
    <div className="notice notice--danger" role="alert"><p>{detailError}</p><button type="button" className="button secondary" onClick={() => reconciliationRequired ? void recheckAfterUncertainResponse() : setDetailRetry(value => value + 1)} disabled={recoveryAudit?.phase === 'loading'}>{reconciliationRequired ? 'Retry account and audit recheck' : 'Retry'}</button></div>
  </div>;
  if (!detail) return null;

  const currentDisabled = Boolean(detail.disabled_at);
  const confirmationSummary = confirmation?.kind === 'roles'
    ? <>Roles: <strong>{roleNames(detail.roles)}</strong> → <strong>{roleNames(confirmation.roles)}</strong>.</>
    : confirmation
      ? <>Account status: <strong>{currentDisabled ? 'Disabled' : 'Active'}</strong> → <strong>{confirmation.disabled ? 'Disabled' : 'Active'}</strong>.</>
      : null;
  const recentAudit = recoveryAudit?.phase === 'ready' ? recoveryAudit.items : [];

  return <div className="admin-page">
    <SectionHeader
      section="Users"
      title={detail.display_name || 'Account details'}
      description="Review and update this server account."
      actions={<a className="button secondary" href="#/admin/users">Back to users</a>}
    />
    {detailNotice && <div className={`notice ${detailNotice.kind === 'warning' ? 'notice--warning' : 'notice--danger'} admin-detail-notice`} role="status" aria-live="polite"><p>{detailNotice.text}</p></div>}
    {success && <p className="notice admin-success" role="status" aria-live="polite">{success}</p>}

    <section className="panel admin-account-summary" aria-labelledby="admin-account-heading">
      <div className="admin-panel-heading"><h2 id="admin-account-heading">Account</h2><span className={`admin-status${currentDisabled ? ' is-disabled' : ''}`}>{userStatus(detail)}</span></div>
      <dl className="admin-account-fields">
        <div><dt>Display name</dt><dd>{detail.display_name || 'No display name'}</dd></div>
        <div><dt>Email</dt><dd>{detail.email || 'Not provided'}</dd></div>
        <div><dt>Login</dt><dd>{detail.login}</dd></div>
        <div><dt>Account UUID</dt><dd><code>{detail.id}</code></dd></div>
        <div><dt>Created</dt><dd><time dateTime={detail.created_at}>{formatAdminDateTime(detail.created_at)}</time></dd></div>
        <div><dt>Revision</dt><dd><code>{detail.revision}</code></dd></div>
      </dl>
    </section>

    <section className="panel admin-access-panel" aria-labelledby="admin-roles-heading">
      <div className="admin-panel-heading"><h2 id="admin-roles-heading">Access roles</h2></div>
      <fieldset className="admin-role-options" disabled={mutationBusy || !mutationsAllowed || reconciliationRequired}>
        <legend className="sr-only">Assign server roles</legend>
        <label><input type="checkbox" checked={rolesDraft.includes('admin')} onChange={event => changeRole('admin', event.target.checked)}/><span>Admin</span></label>
        <label><input type="checkbox" checked={rolesDraft.includes('expert')} onChange={event => changeRole('expert', event.target.checked)}/><span>Expert</span></label>
      </fieldset>
      <div className="admin-action-row">
        <button type="button" className="button primary" onClick={openRoleConfirmation} disabled={!hasRoleChanges || mutationBusy || !mutationsAllowed || reconciliationRequired} aria-busy={mutationBusy} aria-describedby={roleError ? 'admin-role-error' : undefined} data-focus-fallback="admin-main">
          {mutationBusy && confirmation?.kind === 'roles' ? 'Saving roles…' : 'Save role changes'}
        </button>
      </div>
      {roleError && <p className="admin-action-error" id="admin-role-error" role="alert">{roleError}</p>}
    </section>

    <section className="panel admin-status-panel" aria-labelledby="admin-status-heading">
      <div className="admin-panel-heading"><h2 id="admin-status-heading">Account status</h2></div>
      <p className="admin-status-description">{currentDisabled ? 'This account is disabled and cannot sign in.' : 'This account can sign in.'}</p>
      <div className="admin-action-row">
        <button type="button" className={currentDisabled ? 'button primary' : 'button danger'} onClick={openStatusConfirmation} disabled={mutationBusy || !mutationsAllowed || reconciliationRequired} aria-busy={mutationBusy} aria-describedby={statusError ? 'admin-status-error' : undefined} data-focus-fallback="admin-main">
          {mutationBusy && confirmation?.kind === 'status' ? 'Updating status…' : currentDisabled ? 'Enable account' : 'Disable account'}
        </button>
      </div>
      {statusError && <p className="admin-action-error" id="admin-status-error" role="alert">{statusError}</p>}
    </section>

    {recoveryAudit && <section className="panel admin-recovery-audit" aria-labelledby="admin-recovery-heading">
      <div className="admin-panel-heading"><h2 id="admin-recovery-heading">Audit history recheck</h2><a href="#/admin/audit">Open audit log</a></div>
      {recoveryAudit.phase === 'loading' && <p role="status">Re-reading account activity…</p>}
      {recoveryAudit.phase === 'error' && <div className="notice notice--danger" role="alert"><p>{recoveryAudit.error}</p><button type="button" className="button secondary" onClick={() => void recheckAfterUncertainResponse()}>Retry account and audit recheck</button></div>}
      {recoveryAudit.phase === 'ready' && (recentAudit.length
        ? <ol className="admin-recovery-list">{recentAudit.map(entry => <li key={entry.id}>
          <time dateTime={entry.created_at}>{formatAdminDateTime(entry.created_at)}</time>
          <code>{entry.operation}</code>
          <span>{auditStatus(entry.after)} · {roleNames(entry.after.roles)} · revision {entry.after.revision}</span>
        </li>)}</ol>
        : <p>No matching audit events are visible yet.</p>)}
    </section>}

    {confirmation && <Modal title={confirmation.kind === 'roles' ? 'Confirm role changes' : `Confirm ${confirmation.disabled ? 'account disable' : 'account enable'}`} onClose={closeConfirmation} initialFocusRef={reasonInput} closeDisabled={mutationBusy}>
      <form className="admin-confirmation" onSubmit={confirmChange} aria-busy={mutationBusy}>
        <p className="admin-confirmation__change">{confirmationSummary}</p>
        <p>This exact change will be recorded in the audit log.</p>
        {recoveryAudit?.phase === 'loading' && <p className="admin-state" role="status" aria-live="polite">Reading the latest account and audit history. The change will not be sent again.</p>}
        <label className="field" htmlFor="admin-change-reason">
          <span>Reason <span aria-hidden="true">*</span></span>
          <textarea
            id="admin-change-reason"
            ref={reasonInput}
            rows={4}
            required
            value={reason}
            onChange={event => { setReason(event.target.value); setReasonError(''); }}
            aria-invalid={reasonError ? 'true' : undefined}
            aria-describedby={`admin-reason-help${reasonError ? ' admin-reason-error' : ''}`}
            disabled={mutationBusy}
          />
          <small id="admin-reason-help">Required, up to 500 characters. This reason is saved with the audit entry.</small>
          <small>{Array.from(reason.trim()).length} / 500 characters</small>
        </label>
        {reasonError && <p className="admin-action-error" id="admin-reason-error" role="alert">{reasonError}</p>}
        <div className="admin-confirmation__actions">
          <button type="submit" className="button primary" disabled={mutationBusy || !mutationsAllowed || reconciliationRequired || !reason.trim() || Array.from(reason.trim()).length > 500}>
            {mutationBusy ? 'Saving…' : 'Confirm change'}
          </button>
          <button type="button" className="button secondary" onClick={closeConfirmation} disabled={mutationBusy}>Cancel</button>
        </div>
      </form>
    </Modal>}
  </div>;
}

export default function AdminUsers({ userId, onForbidden, mutationsAllowed = false }) {
  return userId
    ? <AccountDetails key={userId} userId={userId} onForbidden={onForbidden} mutationsAllowed={mutationsAllowed}/>
    : <UserList onForbidden={onForbidden}/>;
}
