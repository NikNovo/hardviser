import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  LayoutDashboard, NotebookPen, ChartNoAxesCombined, GitFork, FileText,
  DraftingCompass, Boxes, ListTree, ClipboardCheck, Package, SearchCheck, Shield,
  Scale, FileSignature, Wrench, MapPinned, Users, Landmark, FolderOpen, Quote,
  BrainCircuit, Circle, X, LockKeyhole, PanelLeftOpen, PanelLeftClose, Menu,
  ChevronDown, Download, Folder, ClipboardList, LayoutGrid,
} from 'lucide-react'
import { NAV, pageInfo } from './nav.js'
import { useWorkspace } from './store.jsx'
import Brand from './Brand.jsx'
import useDialogFocus from './useDialogFocus.js'

const Icons = {
  LayoutDashboard, NotebookPen, ChartNoAxesCombined, GitFork, FileText,
  DraftingCompass, Boxes, ListTree, ClipboardCheck, Package, SearchCheck, Shield,
  Scale, FileSignature, Wrench, MapPinned, Users, Landmark, FolderOpen, Quote,
  BrainCircuit, Circle, X, LockKeyhole, PanelLeftOpen, PanelLeftClose, Menu,
  ChevronDown, Download, Folder, ClipboardList, LayoutGrid,
}

const NAVIGATION_STORAGE_KEY = 'hardissoft.navigation.v1'

function normalizeRoute(value) {
  const path = typeof value === 'string' && value.trim() ? value.split('?')[0] : '/overview'
  if (path === '/') return '/overview'
  return path.replace(/\/$/, '') || '/overview'
}


function resolveIcon(value) {
  return Icons[value] || Icons.Circle
}

function isPathActive(route, path) {
  const active = normalizeRoute(route)
  const target = normalizeRoute(path)
  if (target === '/overview') return active === target
  return active === target || active.startsWith(`${target}/`)
}

function isGroupActive(route, group) {
  if (!group) return false
  if (isPathActive(route, group.path)) return true
  return Array.isArray(group.items) && group.items.some((item) => isPathActive(route, item?.path))
}

function safeProjectName(project) {
  const name = typeof project?.name === 'string' ? project.name.trim() : ''
  return name || 'Untitled project'
}

function safeStage(project) {
  const stage = typeof project?.stage === 'string' ? project.stage.trim() : ''
  return stage || 'Stage not specified'
}

function groupIdFor(path) {
  return `nav-subnav-${String(path || 'overview').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')}`
}

function readDisclosureChoices() {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(NAVIGATION_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    const source = parsed?.groups && typeof parsed.groups === 'object' ? parsed.groups : parsed
    if (!source || typeof source !== 'object') return {}
    return Object.fromEntries(
      Object.entries(source).filter(([path, value]) => typeof path === 'string' && typeof value === 'boolean'),
    )
  } catch {
    return {}
  }
}

function initialDisclosureState(groups, route, choices) {
  return groups.reduce((result, group) => {
    const path = group?.path
    if (!path) return result
    result[path] = Object.prototype.hasOwnProperty.call(choices, path)
      ? choices[path]
      : isGroupActive(route, group)
    return result
  }, {})
}

const CHAT_ROUTES = new Set(['/assistant', '/rag-chat'])

function NavItem({ item, route, collapsed, onNavigate }) {
  const Icon = resolveIcon(item?.icon)
  const current = normalizeRoute(route)
  const active = current === item.path
    || (item.path === '/work/catalog' && current.startsWith('/work/new/'))
    || (item.path === '/work' && current.startsWith('/work/') && !current.startsWith('/work/new/') && current !== '/work/catalog')
  const label = item?.label || item?.path || 'Section'

  return (
    <a
      className={`sidebar-link${active ? ' is-active' : ''}`}
      href={`#${item?.path || '/overview'}`}
      aria-label={collapsed ? label : undefined}
      aria-current={active ? 'page' : undefined}
      title={collapsed ? label : undefined}
      onClick={() => onNavigate()}
    >
      <Icon className="sidebar-link__icon" size={16} strokeWidth={1.8} aria-hidden="true" />
      <span className="sidebar-link__label">{label}</span>
    </a>
  )
}

function NavGroup({ group, route, collapsed, expanded, onToggle, onNavigate }) {
  const GroupIcon = resolveIcon(group?.icon)
  const groupPath = group?.path || '/overview'
  const groupActive = isGroupActive(route, group)
  const label = group?.label || groupPath
  const items = Array.isArray(group?.items) ? group.items : []
  const groupId = groupIdFor(groupPath)
  const toggle = () => onToggle(groupPath)

  return (
    <section className={`sidebar-group${groupActive ? ' is-current' : ''}`} aria-label={label}>
      <div className="sidebar-group__heading">
        <button
          className={`sidebar-group__title${groupActive ? ' is-active' : ''}`}
          type="button"
          aria-label={`${expanded ? 'Collapse' : 'Expand'} ${label} group`}
          title={collapsed ? label : undefined}
          aria-controls={items.length > 0 ? groupId : undefined}
          aria-expanded={items.length > 0 ? expanded : undefined}
          onClick={toggle}
        >
          <GroupIcon size={16} strokeWidth={1.8} aria-hidden="true" />
          <span className="sidebar-group__label">{label}</span>
          <ChevronDown className="sidebar-group__chevron" size={14} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </div>
      {items.length > 0 ? (
        <div className="sidebar-subnav" id={groupId} role="group" aria-label={label} hidden={!expanded}>
          {items.map((item) => (
            <NavItem
              key={item.path || item.label}
              item={item}
              route={route}
              collapsed={collapsed}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      ) : null}
    </section>
  )
}


export default function Shell({ route, children, assistant, search, profileMenu, chatExpanded, onOpenChat, onCloseChat }) {
  const { project, activeProjectId, exportProject, storageError } = useWorkspace()
  const normalizedRoute = normalizeRoute(route)
  const navGroups = useMemo(() => (Array.isArray(NAV) ? NAV.filter(Boolean).map(group => ({
    ...group,
    items: group.items?.filter(item => item.path !== '/overview'),
  })) : []), [])
  const hasActiveProject = Boolean(activeProjectId)
  const [sidebarPreference, setSidebarPreference] = useState(false)
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const [disclosureChoices, setDisclosureChoices] = useState(readDisclosureChoices)
  const [expandedGroups, setExpandedGroups] = useState(() => initialDisclosureState(navGroups, normalizedRoute, readDisclosureChoices()))
  const header = useRef(null)
  const shell = useRef(null)
  const navigation = useRef(null)
  const main = useRef(null)
  const savedScroll = useRef(0)
  const restoreScroll = useRef(false)
  const scrolledRoute = useRef(route)
  const [width, setWidth] = useState(() => window.innerWidth)
  const forcedRail = width <= 1099 || (!chatExpanded && width - 232 - 380 < 640)
  const sidebarCollapsed = width > 760 && (sidebarPreference || forcedRail) && !mobileSidebarOpen
  const dockFits = width >= 1100 && width - (sidebarCollapsed ? 60 : 232) - 380 >= 640
  useDialogFocus({ active: mobileSidebarOpen, dialogRef: navigation, onClose: () => setMobileSidebarOpen(false) })

  useEffect(() => {
    const observer = new ResizeObserver(entries => setWidth(entries[0].contentRect.width))
    observer.observe(shell.current)
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    const previous = scrolledRoute.current
    if (previous === route) return
    scrolledRoute.current = route
    if (CHAT_ROUTES.has(previous) || CHAT_ROUTES.has(route)) return
    if (main.current) main.current.scrollTop = 0
  }, [route])

  useEffect(() => {
    if (chatExpanded || !restoreScroll.current || !main.current) return
    main.current.scrollTop = savedScroll.current
    if (!CHAT_ROUTES.has(route)) restoreScroll.current = false
  }, [chatExpanded, route])

  function rememberWorkspaceScroll() {
    savedScroll.current = main.current?.scrollTop || 0
    restoreScroll.current = true
  }

  function openNavigation() {
    if (document.querySelector('[role="dialog"][aria-modal="true"]')) return
    setMobileSidebarOpen(true)
  }

  function toggleNavigation() {
    if (forcedRail) openNavigation()
    else setSidebarPreference(value => !value)
  }

  useEffect(() => {
    const node = header.current
    const measure = () => node?.closest('.app-shell')?.style.setProperty('--header-height', `${node.getBoundingClientRect().height}px`)
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    if (node && observer) observer.observe(node)
    measure()
    return () => observer?.disconnect()
  }, [])

  useEffect(() => {
    if (width > 760 && mobileSidebarOpen && !forcedRail && !sidebarPreference) setMobileSidebarOpen(false)
  }, [width, forcedRail, sidebarPreference, mobileSidebarOpen])

  const currentNavLabel = useMemo(() => {
    const info = pageInfo(normalizedRoute)
    return info?.title || 'Workspace'
  }, [normalizedRoute])

  useEffect(() => {
    setMobileSidebarOpen(false)
  }, [normalizedRoute])

  useEffect(() => {
    setExpandedGroups((current) => {
      const next = { ...current }
      let changed = false
      navGroups.forEach((group) => {
        const path = group?.path
        if (!path || Object.prototype.hasOwnProperty.call(disclosureChoices, path) || !isGroupActive(normalizedRoute, group)) return
        if (!next[path]) {
          next[path] = true
          changed = true
        }
      })
      return changed ? next : current
    })
  }, [disclosureChoices, navGroups, normalizedRoute])

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(NAVIGATION_STORAGE_KEY, JSON.stringify(disclosureChoices))
    } catch {
      // Navigation remains usable when storage is blocked or unavailable.
    }
  }, [disclosureChoices])


  const handleNavigate = () => {
    setMobileSidebarOpen(false)
    if (chatExpanded) onCloseChat?.()
  }

  const handleDisclosureToggle = (path) => {
    if (sidebarCollapsed) openNavigation()
    const nextValue = !Boolean(expandedGroups[path])
    setExpandedGroups((current) => ({ ...current, [path]: nextValue }))
    setDisclosureChoices((current) => ({ ...current, [path]: nextValue }))
  }

  const handleCofounderJump = (event) => {
    event.preventDefault()
    if (chatExpanded) {
      onCloseChat?.()
      requestAnimationFrame(() => main.current?.focus({ preventScroll: true }))
      return
    }
    rememberWorkspaceScroll()
    onOpenChat()
    requestAnimationFrame(() => {
      const panel = document.getElementById('cofounder-panel')
      const target = panel?.querySelector('textarea:not(:disabled)') || panel?.querySelector('select')
      target?.focus({ preventScroll: true })
    })
  }

  const projectName = hasActiveProject ? safeProjectName(project) : 'Select workspace'
  const stage = hasActiveProject ? safeStage(project) : ''
  const hasSearch = search !== null && search !== undefined
  const shellClassName = ['app-shell', sidebarCollapsed ? 'is-sidebar-collapsed' : '', mobileSidebarOpen ? 'has-nav-overlay' : '', !dockFits ? 'is-single-pane' : ''].filter(Boolean).join(' ')

  return (
    <div className={shellClassName} ref={shell}>
      <a className="skip-link" href="#main-content" inert={mobileSidebarOpen || undefined} onClick={(event) => { event.preventDefault(); document.getElementById('main-content')?.focus() }}>Skip to content</a>

      <div
        className={`shell-scrim${mobileSidebarOpen ? ' is-visible' : ''}`}
        aria-hidden="true"
        onClick={() => setMobileSidebarOpen(false)}
        data-dialog-backdrop=""
      />

      <div ref={navigation} tabIndex={-1} id="project-navigation" className={`sidebar${mobileSidebarOpen ? ' is-open' : ''}`} aria-label="Project navigation" role={mobileSidebarOpen ? 'dialog' : 'complementary'} aria-modal={mobileSidebarOpen || undefined}>
        <div className="sidebar__topline">
          <a className="product-wordmark" href="#/overview" onClick={handleNavigate} aria-label="hardviser, project overview">
            <Brand size={24} wordmark={!sidebarCollapsed}/>
          </a>
          <button
            className="icon-button sidebar__close"
            type="button"
            aria-label="Close navigation"
            onClick={() => setMobileSidebarOpen(false)}
          >
            <Icons.X size={18} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </div>

        <div className={`project-context${hasActiveProject ? '' : ' is-empty'}`} aria-label="Current project">
          <div className="project-context__copy">
            <span className="project-context__label">Local workspace</span>
            <strong>{projectName}</strong>
            <span className="project-context__stage">{stage}</span>
          </div>
        </div>

        <nav className="sidebar__nav" aria-label="Workspace sections">
          <NavItem item={{ path: '/assistant', label: 'AI Cofounder', icon: 'BrainCircuit' }} route={chatExpanded ? '/assistant' : normalizedRoute} collapsed={sidebarCollapsed} onNavigate={() => { setMobileSidebarOpen(false); if (!chatExpanded) rememberWorkspaceScroll(); onOpenChat() }}/>
          <NavItem item={{ path: '/overview', label: 'Overview', icon: 'LayoutDashboard' }} route={chatExpanded ? '/assistant' : normalizedRoute} collapsed={sidebarCollapsed} onNavigate={handleNavigate}/>
          {hasActiveProject ? <>
            <span className="sidebar__section-label" aria-hidden="true">{sidebarCollapsed ? '' : 'Workspace'}</span>
            {navGroups.map((group) => (
              <NavGroup
                key={group.path || group.label}
                group={group}
                route={chatExpanded ? '/assistant' : normalizedRoute}
                collapsed={sidebarCollapsed}
                expanded={Boolean(expandedGroups[group.path])}
                onToggle={handleDisclosureToggle}
                onNavigate={handleNavigate}
              />
            ))}
          </> : <NavItem item={{ path: '/new-project', label: 'Create a project', icon: 'FolderOpen' }} route={normalizedRoute} collapsed={sidebarCollapsed} onNavigate={handleNavigate}/>}
        </nav>

        <div className="sidebar__bottom">
          <div className="sidebar__controls">
            <button
              className="sidebar-control"
              type="button"
              onClick={toggleNavigation}
              aria-controls="project-navigation"
              aria-label={sidebarCollapsed ? 'Expand navigation' : 'Collapse navigation'}
              aria-expanded={!sidebarCollapsed}
              title={sidebarCollapsed ? 'Expand navigation' : 'Collapse navigation'}
            >
              {sidebarCollapsed ? <Icons.PanelLeftOpen size={17} strokeWidth={1.8} aria-hidden="true" /> : <Icons.PanelLeftClose size={17} strokeWidth={1.8} aria-hidden="true" />}
              <span>{sidebarCollapsed ? 'Expand menu' : 'Collapse menu'}</span>
            </button>
          </div>
        </div>
      </div>

      <div className={`shell-workspace${chatExpanded ? ' is-chat-expanded' : ''}`}>
        <header ref={header} className={`shell-header${hasSearch ? ' has-global-search' : ''}`}>
          <div className="shell-header__left">
            <button
              className="icon-button mobile-menu-trigger"
              type="button"
              aria-label="Open navigation"
              aria-controls="project-navigation"
              aria-expanded={mobileSidebarOpen}
              onClick={openNavigation}
            >
              <Icons.Menu size={19} strokeWidth={1.8} aria-hidden="true" />
            </button>
            <a className="shell-header__brand" href="#/overview" onClick={handleNavigate} aria-label="hardviser, project overview">
              <Brand size={24} wordmark={false}/>
            </a>
            <nav className="shell-breadcrumb" aria-label="Current location">
              {chatExpanded ? <span className="shell-breadcrumb__current" aria-current="page">AI Cofounder</span> : <>
                <a className="shell-breadcrumb__overview" href="#/overview" onClick={handleNavigate}>Workspace</a>
                <span className="shell-breadcrumb__separator" aria-hidden="true">/</span>
                <span className="shell-breadcrumb__project">{pageInfo(normalizedRoute).group}</span>
                <span className="shell-breadcrumb__separator" aria-hidden="true">/</span>
                <span className="shell-breadcrumb__current" aria-current="page">{currentNavLabel}</span>
              </>}
            </nav>
          </div>

          {hasSearch ? <div className="shell-header__search">{search}</div> : null}

          <div className="shell-header__actions">
            <button type="button" className="cofounder-jump" aria-controls="cofounder-panel" aria-expanded={chatExpanded} onClick={handleCofounderJump}>{chatExpanded ? 'Back to workspace' : 'AI Cofounder'}</button>
            {profileMenu ? <div className="shell-header__profile">{profileMenu}</div> : null}
          </div>
          {storageError && <div className="storage-error" role="alert">{storageError}</div>}
        </header>

        <div className="shell-workspace__body">
          <main ref={main} id="main-content" className="shell-main" tabIndex="-1">
            {children}
        <footer className="shell-footer">
          <div className="shell-footer__identity">
            <span className="shell-footer__status"><span className="status-dot" aria-hidden="true" /> Local workspace</span>
          </div>
          <nav className="shell-footer__legal" aria-label="Legal and data links">
            <a href="#/legal/code-of-conduct" onClick={handleNavigate}>Code of Conduct</a>
            <a href="#/legal/nda" onClick={handleNavigate}>NDA</a>
            <a href="#/legal/terms" onClick={handleNavigate}>Terms</a>
            <a href="#/legal/privacy" onClick={handleNavigate}>Privacy</a>
            <a href="#/legal/ip" onClick={handleNavigate}>Intellectual property</a>
            <a href="#/settings/access" onClick={handleNavigate}>Data settings</a>
          </nav>
          <div className="shell-footer__links">
            {hasActiveProject && <button className="button button-ghost" type="button" onClick={exportProject}>
              <Icons.Download size={15} strokeWidth={1.8} aria-hidden="true" />
              <span>Export current project</span>
            </button>}
          </div>
        </footer>
          </main>

          <aside id="cofounder-panel" className="assistant-panel" aria-label="AI Cofounder">
            <div className="assistant-panel__body">{assistant}</div>
          </aside>
        </div>

      </div>
    </div>
  )
}
