import { SCHEMAS } from './records-schema.js';
import { SANDBOX_BILLING_ENABLED } from './billing-config.js';
export const RAG_CHAT_ENABLED = import.meta.env?.VITE_RAG_CHAT_ENABLED === 'true';

export const RECORD_ROUTES = {
  decision: '/project/decisions', document: '/development/documents', prototype: '/development/prototypes', module: '/development/modules', bom: '/development/bom', test: '/development/tests', supplier: '/supply', counterparty: '/supply/due-diligence', protection: '/protection', patent: '/protection/patents', contract: '/protection/contracts', tooling: '/protection/tooling', requirement: '/protection/markets', expert: '/experts', grant: '/funding/programs', library: '/library', observation: '/library/evidence', work: '/work'
};
const recordItem = (kind, icon) => ({ label: SCHEMAS[kind].plural, path: RECORD_ROUTES[kind], icon });

// Folders describe the project. Only their leaf items are pages.
export const NAV = [
  { label: 'Project', icon: 'Folder', path: '/project', items: [
    { label: 'Overview', path: '/overview', icon: 'LayoutDashboard' },
    { label: 'Project brief', path: '/project/passport', icon: 'NotebookPen' },
    { label: 'Readiness', path: '/project/readiness', icon: 'ChartNoAxesCombined' },
    recordItem('decision', 'GitFork')
  ] },
  { label: 'Development', icon: 'Folder', path: '/development', items: [
    recordItem('document', 'FileText'), recordItem('prototype', 'DraftingCompass'),
    recordItem('module', 'Boxes'), recordItem('bom', 'ListTree'), recordItem('test', 'ClipboardCheck')
  ] },
  { label: 'Supply', icon: 'Folder', path: '/supply', items: [
    recordItem('supplier', 'Package'), recordItem('counterparty', 'SearchCheck')
  ] },
  { label: 'Protection', icon: 'Folder', path: '/protection', items: [
    recordItem('protection', 'Shield'), recordItem('patent', 'Scale'), recordItem('contract', 'FileSignature'),
    recordItem('tooling', 'Wrench'), recordItem('requirement', 'MapPinned')
  ] },
  { label: 'People & funding', icon: 'Folder', path: '/people', items: [
    recordItem('expert', 'Users'), recordItem('grant', 'Landmark')
  ] },
  { label: 'Work', icon: 'Folder', path: '/work', items: [
    { label: 'Requests', path: '/work', icon: 'ClipboardList' },
    { label: 'Service catalog', path: '/work/catalog', icon: 'LayoutGrid' }
  ] },
  { label: 'Knowledge', icon: 'Folder', path: '/knowledge', items: [
    recordItem('library', 'FolderOpen'), recordItem('observation', 'Quote'),
    { label: 'Project memory', path: '/memory', icon: 'BrainCircuit' }
  ] }
];
export const UTILITY_PAGES = [
  { label: 'Profile', path: '/profile', group: 'Account' },
  ...(SANDBOX_BILLING_ENABLED ? [{ label: 'Sandbox billing', path: '/billing', group: 'Account' }] : []),
  { label: 'Data settings', path: '/settings/access', group: 'Account' },
  { label: 'AI Cofounder', path: '/assistant', group: 'Project' },
  ...(RAG_CHAT_ENABLED ? [{ label: 'RAG chat', path: '/rag-chat', group: 'Public testing' }] : []),
  { label: 'Code of Conduct', path: '/legal/code-of-conduct', group: 'Legal' },
  { label: 'NDA review draft', path: '/legal/nda', group: 'Legal' },
  { label: 'Test workspace terms', path: '/legal/terms', group: 'Legal' },
  { label: 'Privacy & data handling', path: '/legal/privacy', group: 'Legal' },
  { label: 'Intellectual property & ownership', path: '/legal/ip', group: 'Legal' }
];
export function pageInfo(path) {
  const route = path.split('?')[0];
  for (const group of NAV) {
    const item = group.items.find(item => item.path === route);
    if (item) return { group: group.label, title: item.label, path: item.path };
  }
  if (route === '/billing') return { group: 'Account', title: 'Sandbox billing', path: route };
  const utility = UTILITY_PAGES.find(item => item.path === route);
  if (utility) return { group: utility.group, title: utility.label, path: utility.path };
  return { group: route.startsWith('/work/') ? 'Work' : 'Workspace', title: route.startsWith('/work/') ? 'Request' : 'Workspace', path: route };
}
export function recordRoute(record) { return record.type === 'work' ? `/work/${record.id}` : RECORD_ROUTES[record.type] || '/library'; }
