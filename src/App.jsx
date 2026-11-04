import React, { lazy, Suspense, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import DashboardLogin, { EmailAuthConfirmation } from './DashboardLogin.jsx';
import { getRagChatSession, initializeRagChatSession, selectSessionProject, subscribeRagChatSession } from './rag-chat-session.js';
import Shell from './Shell.jsx';
import DataPage from './DataPages.jsx';
import WorkPage from './WorkPages.jsx';
import { MemoryPage, SettingsPage } from './Assistant.jsx';
import RagChat from './RagChat.jsx';
import { Overview, Passport, Readiness } from './ProjectPages.jsx';
import { useWorkspace, WorkspaceProvider } from './store.jsx';
import GlobalSearch from './GlobalSearch.jsx';
import LegalPage from './LegalPages.jsx';
import { ProfileMenu, ProfilePage } from './Profile.jsx';
import Onboarding from './Onboarding.jsx';
import { pageInfo } from './nav.js';
const AdminApp = lazy(() => import('./admin/AdminApp.jsx'));
const BillingPage = lazy(() => import('./BillingPage.jsx'));

const DATA_ROUTES = {
  '/project/decisions': 'decision', '/development/documents': 'document', '/development/prototypes': 'prototype', '/development/modules': 'module', '/development/bom': 'bom', '/development/tests': 'test', '/supply': 'supplier', '/supply/due-diligence': 'counterparty', '/protection': 'protection', '/protection/patents': 'patent', '/protection/contracts': 'contract', '/protection/tooling': 'tooling', '/protection/markets': 'requirement', '/experts': 'expert', '/funding/programs': 'grant', '/library': 'library', '/library/evidence': 'observation'
};
function currentRoute() { return window.location.hash.slice(1) || '/overview'; }
export default function App() {
  const [route, setRoute] = useState(currentRoute);
  const path = route.split('?')[0];
  const isLegalRoute = path.startsWith('/legal/');
  const isAdminRoute = path === '/admin' || path.startsWith('/admin/');
  const isEmailAuthRoute = path === '/auth/email';
  const session = useSyncExternalStore(subscribeRagChatSession, getRagChatSession);
  useEffect(() => { void initializeRagChatSession(); }, []);
  useEffect(() => {
    const change = () => { setRoute(currentRoute()); window.scrollTo(0, 0); };
    window.addEventListener('hashchange', change);
    return () => window.removeEventListener('hashchange', change);
  }, []);
  useEffect(() => {
    if (session.authenticated && !isEmailAuthRoute && !isAdminRoute) return;
    const title = isEmailAuthRoute ? 'Confirm email sign-in'
      : !session.authenticated && !isLegalRoute ? session.initialized ? 'Sign in' : 'Checking sign-in'
        : isAdminRoute ? path === '/admin/audit' ? 'Audit log' : 'Users' : pageInfo(path).title;
    document.title = `${title} — hardviser.com`;
  }, [isAdminRoute, isEmailAuthRoute, isLegalRoute, path, session.authenticated, session.initialized]);
  if (isEmailAuthRoute) {
    const token = new URLSearchParams(route.split('?')[1] || '').get('token') || '';
    return <DashboardLogin><EmailAuthConfirmation key={token || 'missing'} token={token} session={session}/></DashboardLogin>;
  }
  if (!session.authenticated && isLegalRoute) {
    return <DashboardLogin><LegalPage page={path.slice('/legal/'.length)}/></DashboardLogin>;
  }
  if (!session.initialized || session.authChecking) return <DashboardLogin checking/>;
  if (!session.authenticated) return <DashboardLogin/>;
  if (isAdminRoute) {
    return <Suspense fallback={<p role="status">Loading administration…</p>}>
      <AdminApp route={path}/>
    </Suspense>;
  }
  return <WorkspaceProvider key={session.userId} accountId={session.userId}>
    <WorkspaceApp route={route} session={session}/>
  </WorkspaceProvider>;
}

function WorkspaceApp({ route, session }) {
  const path = route.split('?')[0];
  const isLegalRoute = path.startsWith('/legal/');
  const [chatExpanded, setChatExpanded] = useState(() => ['/rag-chat', '/assistant'].includes(currentRoute().split('?')[0]));
  const [setupInProgress, setSetupInProgress] = useState(false);
  const previousWorkspaceRoute = useRef('/overview');
  const syncedLink = useRef('');
  const syncedActiveProject = useRef(null);
  const recordId = new URLSearchParams(route.split('?')[1] || '').get('record');
  const { go, activeProjectId, linkedServerProjectId } = useWorkspace();
  const allowsNoProject = path === '/profile' || path === '/billing' || path === '/settings/access' || isLegalRoute;
  const showOnboarding = path === '/new-project' || setupInProgress || (!activeProjectId && !allowsNoProject);
  useEffect(() => {
    document.title = `${showOnboarding ? 'Set up your project' : pageInfo(path).title} — hardviser.com`;
  }, [path, showOnboarding]);
  useEffect(() => {
    const isChatRoute = ['/rag-chat', '/assistant'].includes(path);
    if (!isChatRoute && path !== '/new-project') previousWorkspaceRoute.current = route;
    setChatExpanded(isChatRoute);
  }, [path, route]);
  useEffect(() => {
    if (!session.authenticated) {
      syncedLink.current = '';
      return;
    }
    const switched = syncedActiveProject.current !== null && syncedActiveProject.current !== activeProjectId;
    syncedActiveProject.current = activeProjectId;
    if (switched) syncedLink.current = '';
    if (!activeProjectId) return;
    const linkAvailable = Boolean(linkedServerProjectId) && session.projects.some(project => project.id === linkedServerProjectId);
    if (!linkAvailable) {
      // Another project's AI chat must not stay open for a project without its own AI project.
      if (switched && session.selectedProjectId) void selectSessionProject(null);
      return;
    }
    const key = `${activeProjectId}:${linkedServerProjectId}`;
    if (syncedLink.current === key) return;
    syncedLink.current = key;
    if (session.selectedProjectId !== linkedServerProjectId) void selectSessionProject(linkedServerProjectId);
  }, [activeProjectId, linkedServerProjectId, session.authenticated, session.projects, session.selectedProjectId]);
  function closeChat() {
    setChatExpanded(false);
    if (['/rag-chat', '/assistant'].includes(path)) go(previousWorkspaceRoute.current);
  }

  if (showOnboarding) {
    return <Onboarding mode={activeProjectId ? 'new' : 'first-run'} onCancel={() => go(previousWorkspaceRoute.current)} onBusyChange={setSetupInProgress}/>;
  }

  let content;
  if (path === '/profile') content = <ProfilePage />;
  else if (path === '/billing') content = <Suspense fallback={<p role="status">Loading sandbox billing…</p>}><BillingPage session={session}/></Suspense>;
  else if (path === '/settings/access') content = <SettingsPage />;
  else if (isLegalRoute) content = <LegalPage page={path.slice('/legal/'.length)} />;
  else if (path === '/rag-chat' || path === '/assistant') content = <Overview />;
  else if (path === '/overview') content = <Overview />;
  else if (path === '/project/passport') content = <Passport />;
  else if (path === '/project/readiness') content = <Readiness />;
  else if (path === '/memory') content = <MemoryPage />;
  else if (DATA_ROUTES[path]) content = <DataPage kind={DATA_ROUTES[path]} initialRecordId={recordId} />;
  else if (path === '/work/catalog') content = <WorkPage view="catalog" />;
  else if (path.startsWith('/work/new/')) content = <WorkPage recipeId={path.slice('/work/new/'.length)} />;
  else if (path === '/work') content = <WorkPage view="requests" />;
  else if (path.startsWith('/work/')) content = <WorkPage workId={path.slice('/work/'.length)} />;
  else content = <div className="panel empty-state"><h1>Page not found</h1><p>Choose an area of your project in the navigation.</p><button className="button primary" onClick={() => go('/overview')}>Return to workspace</button></div>;
  return <Shell route={path} chatExpanded={chatExpanded} onOpenChat={() => setChatExpanded(true)} onCloseChat={closeChat} assistant={<RagChat expanded={chatExpanded} onToggleExpanded={() => chatExpanded ? closeChat() : setChatExpanded(true)} />} search={<GlobalSearch key={activeProjectId || 'empty'} />} profileMenu={<ProfileMenu />}><div key={`${activeProjectId || 'empty'}:${route}`} className="route-content">{content}</div></Shell>;
}
