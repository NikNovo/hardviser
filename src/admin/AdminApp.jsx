import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import Brand from '../Brand.jsx';
import { ProfileMenu } from '../Profile.jsx';
import SectionHeader from '../SectionHeader.jsx';
import { getRagChatSession, refreshSessionAccount, subscribeRagChatSession } from '../rag-chat-session.js';
import AdminAudit from './AdminAudit.jsx';
import AdminUsers from './AdminUsers.jsx';
import { adminErrorText, isAbortError, isForbiddenError } from './admin-helpers.js';
import './admin.css';

const ADMIN_USER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function pageForRoute(route) {
  if (route === '/admin' || route === '/admin/users') return { page: 'users' };
  if (route === '/admin/audit') return { page: 'audit' };
  const match = route.match(/^\/admin\/users\/([^/]+)$/);
  if (match) {
    try {
      const userId = decodeURIComponent(match[1]);
      return ADMIN_USER_UUID.test(userId) ? { page: 'user', userId } : { page: 'not-found' };
    } catch {
      return { page: 'not-found' };
    }
  }
  return { page: 'not-found' };
}

export default function AdminApp({ route }) {
  const session = useSyncExternalStore(subscribeRagChatSession, getRagChatSession);
  const [accessState, setAccessState] = useState('checking');
  const [refreshError, setRefreshError] = useState('');
  const [verifiedUserId, setVerifiedUserId] = useState(null);
  const requestId = useRef(0);
  const refreshController = useRef(null);
  const mainRef = useRef(null);
  const accessUserId = useRef(session.userId);
  const verifiedUserIdRef = useRef(null);
  const hadAdminAccess = useRef(false);

  const refreshAccess = useCallback(({ focusMain = false, background = false } = {}) => {
    const currentRequest = ++requestId.current;
    refreshController.current?.abort();
    const controller = new AbortController();
    refreshController.current = controller;
    const accountAtRequest = getRagChatSession();
    const requestedUserId = accountAtRequest.userId;
    const keepAdminView = background
      && requestedUserId !== null
      && verifiedUserIdRef.current === requestedUserId
      && accountAtRequest.roles?.includes('admin') === true;
    if (!keepAdminView) {
      verifiedUserIdRef.current = null;
      setVerifiedUserId(null);
    }
    if (focusMain) mainRef.current?.focus({ preventScroll: true });
    setRefreshError('');
    setAccessState(keepAdminView ? 'rechecking' : 'checking');
    void refreshSessionAccount(controller.signal).then(user => {
      if (currentRequest !== requestId.current) return;
      if (user?.id !== requestedUserId || getRagChatSession().userId !== requestedUserId) {
        verifiedUserIdRef.current = null;
        setVerifiedUserId(null);
        setRefreshError('The signed-in account changed while access was being checked. Try again.');
        setAccessState('error');
        return;
      }
      if (!user.roles?.includes('admin')) {
        verifiedUserIdRef.current = null;
        setVerifiedUserId(null);
        setRefreshError('');
        setAccessState('forbidden');
        return;
      }
      verifiedUserIdRef.current = requestedUserId;
      setVerifiedUserId(requestedUserId);
      setRefreshError('');
      setAccessState('ready');
    }).catch(error => {
      if (currentRequest !== requestId.current) return;
      if (isAbortError(error)) {
        if (!controller.signal.aborted) {
          verifiedUserIdRef.current = null;
          setVerifiedUserId(null);
          setRefreshError('The server account changed while access was being checked. Try again.');
          setAccessState('error');
        }
        return;
      }
      if (error?.status === 401) {
        verifiedUserIdRef.current = null;
        setVerifiedUserId(null);
        setRefreshError(adminErrorText(error, 'Could not verify administrator access. Try again.'));
        setAccessState('error');
        return;
      }
      if (isForbiddenError(error)) {
        verifiedUserIdRef.current = null;
        setVerifiedUserId(null);
        setRefreshError('');
        setAccessState('forbidden');
        return;
      }
      setRefreshError(adminErrorText(error, 'Could not verify administrator access. Try again.'));
      setAccessState(keepAdminView ? 'recheck-error' : 'error');
    }).finally(() => {
      if (refreshController.current === controller) refreshController.current = null;
    });
  }, []);

  useEffect(() => {
    const identityChanged = accessUserId.current !== session.userId;
    accessUserId.current = session.userId;
    if (identityChanged) {
      verifiedUserIdRef.current = null;
      setVerifiedUserId(null);
    }
    const background = !identityChanged
      && verifiedUserIdRef.current === session.userId
      && session.roles?.includes('admin') === true;
    refreshAccess({ focusMain: identityChanged, background });
    function onFocus() {
      if (document.visibilityState === 'visible') {
        const currentSession = getRagChatSession();
        const canRevalidateInBackground = verifiedUserIdRef.current === currentSession.userId
          && currentSession.roles?.includes('admin') === true;
        refreshAccess({ focusMain: false, background: canRevalidateInBackground });
      }
    }
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      requestId.current += 1;
      refreshController.current?.abort();
      refreshController.current = null;
    };
  }, [refreshAccess, session.userId]);

  useEffect(() => {
    mainRef.current?.focus({ preventScroll: true });
  }, [route]);

  const onForbidden = useCallback(() => {
    requestId.current += 1;
    refreshController.current?.abort();
    refreshController.current = null;
    verifiedUserIdRef.current = null;
    setVerifiedUserId(null);
    setRefreshError('');
    setAccessState('forbidden');
    void refreshSessionAccount().catch(() => {});
  }, []);
  const routeInfo = pageForRoute(route);
  const isAdmin = session.roles?.includes('admin') === true;
  const canViewAdmin = ['ready', 'rechecking', 'recheck-error'].includes(accessState)
    && verifiedUserId !== null
    && verifiedUserId === session.userId
    && isAdmin;
  const serverAccount = session.displayName || session.loginName || 'Signed in';
  useLayoutEffect(() => {
    if (hadAdminAccess.current && !canViewAdmin) mainRef.current?.focus({ preventScroll: true });
    hadAdminAccess.current = canViewAdmin;
  }, [canViewAdmin]);


  return <div className="admin-app">
    <header className="admin-header">
      <a className="admin-brand" href="#/overview" aria-label="Hardviser — return to workspace"><Brand size={24} wordmark/></a>
      {canViewAdmin && <nav className="admin-navigation" aria-label="Administration">
        <a href="#/admin/users" aria-current={routeInfo.page === 'users' || routeInfo.page === 'user' ? 'page' : undefined}>Users</a>
        <a href="#/admin/audit" aria-current={routeInfo.page === 'audit' ? 'page' : undefined}>Audit log</a>
      </nav>}
      <div className="admin-header-account">
        <div className="admin-server-identity"><span>Server account</span><strong>{serverAccount}</strong>{session.displayName && session.loginName && <small>{session.loginName}</small>}</div>
        <ProfileMenu/>
      </div>
    </header>

    <main className="admin-main" id="admin-main" ref={mainRef} tabIndex={-1}>
      {canViewAdmin && accessState === 'rechecking' && <div className="notice admin-state admin-access-recheck" role="status" aria-live="polite">
        <p>Checking administrator access. Read-only content and your current review remain available; changes are paused until verification completes.</p>
      </div>}
      {canViewAdmin && accessState === 'recheck-error' && <div className="notice notice--warning admin-state admin-access-recheck" role="alert">
        <p>{refreshError}</p>
        <button type="button" className="button secondary" onClick={() => refreshAccess({ focusMain: false, background: true })}>Retry access check</button>
      </div>}
      {accessState === 'checking' && <p className="admin-state" role="status" aria-live="polite">Checking administrator access…</p>}
      {accessState === 'rechecking' && !canViewAdmin && <p className="admin-state" role="status" aria-live="polite">Checking administrator access…</p>}
      {(accessState === 'error' || (accessState === 'recheck-error' && !canViewAdmin)) && <div className="panel admin-access-error">
        <SectionHeader section="Administration" title="Unable to verify access" description={refreshError}/>
        <button type="button" className="button primary" onClick={() => refreshAccess({ focusMain: true })}>Try again</button>
      </div>}
      {(accessState === 'forbidden' || (['ready', 'rechecking', 'recheck-error'].includes(accessState) && verifiedUserId === session.userId && !isAdmin)) && <div className="panel admin-forbidden" role="status">
        <SectionHeader section="Administration" title="You do not have access to administration"/>
        <a className="button secondary" href="#/overview">Return to workspace</a>
      </div>}
      {canViewAdmin && routeInfo.page === 'users' && <AdminUsers onForbidden={onForbidden} mutationsAllowed={accessState === 'ready'}/>}
      {canViewAdmin && routeInfo.page === 'user' && <AdminUsers key={routeInfo.userId} userId={routeInfo.userId} onForbidden={onForbidden} mutationsAllowed={accessState === 'ready'}/>}
      {canViewAdmin && routeInfo.page === 'audit' && <AdminAudit onForbidden={onForbidden}/>}
      {canViewAdmin && routeInfo.page === 'not-found' && <div className="panel admin-not-found">
        <SectionHeader section="Administration" title="Page not found" description="This administration page does not exist."/>
        <a className="button secondary" href="#/overview">Return to workspace</a>
      </div>}
    </main>
  </div>;
}
