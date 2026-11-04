import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Search, ArrowUpRight, X } from 'lucide-react';
import { NAV, UTILITY_PAGES, recordRoute } from './nav.js';
import { SCHEMAS } from './records-schema.js';
import { useWorkspace } from './store.jsx';
import { RECIPES } from './recipes.js';
import { createPortal } from 'react-dom';
import useDialogFocus from './useDialogFocus.js';
import './global-search.css';

export function recordLink(record) {
  const route = recordRoute(record);
  return record.type === 'work' ? route : `${route}?record=${encodeURIComponent(record.id)}`;
}
export function searchRecords(records, query) {
  const words = query.trim().toLocaleLowerCase('en-US').split(/\s+/).filter(Boolean);
  return records.filter(record => {
    const text = `${record.title} ${record.notes || ''} ${JSON.stringify(record.fields || {})}`.toLocaleLowerCase('en-US');
    return words.every(word => text.includes(word));
  });
}
export default function GlobalSearch() {
  const { records, go, activeProjectId } = useWorkspace();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const listId = useId();
  const input = useRef(null);
  const dialog = useRef(null);
  const shortcutLabel = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘ K' : 'Ctrl K';
  useDialogFocus({ active: open, dialogRef: dialog, onClose: () => setOpen(false), initialFocusRef: input });
  useEffect(() => {
    function shortcut(event) {
      if (event.isComposing || event.altKey || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k') return;
      const target = event.target;
      if (target instanceof HTMLElement && !dialog.current?.contains(target)
        && (target.isContentEditable || target.closest('input, textarea, select, [role="textbox"]'))) return;
      const anotherDialog = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')]
        .some(node => node !== dialog.current && node.getClientRects().length);
      if (anotherDialog) return;
      event.preventDefault();
      setOpen(true);
    }
    document.addEventListener('keydown', shortcut);
    return () => document.removeEventListener('keydown', shortcut);
  }, []);
  const results = useMemo(() => {
    if (!query.trim()) return [];
    const words = query.trim().toLocaleLowerCase('en-US').split(/\s+/);
    const pages = [...(activeProjectId ? NAV.flatMap(group => group.items) : []), ...UTILITY_PAGES.filter(item => activeProjectId || item.path !== '/assistant')]
      .filter(item => words.every(word => item.label.toLocaleLowerCase('en-US').includes(word)))
      .map(item => ({ id: item.path, title: item.label, detail: 'Workspace page', path: item.path }));
    const found = searchRecords(records, query).map(record => ({ id: record.id, title: record.title, detail: record.type === 'work' ? 'Work request' : SCHEMAS[record.type]?.label || 'Record', path: recordLink(record) }));
    const recipes = activeProjectId ? RECIPES.filter(recipe => words.every(word => `${recipe.title} ${recipe.description} ${recipe.category}`.toLocaleLowerCase('en-US').includes(word))).map(recipe => ({ id: `recipe-${recipe.id}`, title: recipe.title, detail: `Service · ${recipe.category}`, path: `/work/new/${recipe.id}` })) : [];
    return [...found, ...pages, ...recipes].slice(0, 10);
  }, [query, records, activeProjectId]);
  useEffect(() => {
    if (open && active >= 0) document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active, listId]);
  function choose(result) { go(result.path); setOpen(false); setActive(-1); }
  function keydown(event) {
    if (event.isComposing) return;
    if (event.key === 'Escape') { setOpen(false); setActive(-1); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); setOpen(true);
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      setActive(index => !results.length ? -1 : index < 0 ? (direction > 0 ? 0 : results.length - 1) : (index + direction + results.length) % results.length);
    }
    if (event.key === 'Enter' && results.length) { event.preventDefault(); choose(results[active < 0 ? 0 : active]); }
  }
  return <>
    <button type="button" className="search-trigger" onClick={() => setOpen(true)} aria-haspopup="dialog" aria-label="Search workspace">
      <Search size={18} aria-hidden="true"/><span>Search workspace</span><kbd>{shortcutLabel}</kbd>
    </button>
    {open && createPortal(
      <div className="search-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setOpen(false); }}>
        <section className="search-palette" role="dialog" aria-modal="true" aria-label="Search workspace" ref={dialog} tabIndex={-1}>
          <div className="search-palette__field">
            <Search size={20} aria-hidden="true"/>
            <label className="sr-only" htmlFor={`${listId}-input`}>Search workspace</label>
            <input id={`${listId}-input`} ref={input} type="search" role="combobox" autoComplete="off" aria-autocomplete="list" aria-controls={listId} aria-expanded={true} aria-activedescendant={active >= 0 && results[active] ? `${listId}-${active}` : undefined} placeholder="Find a record, page or recipe…" value={query} onChange={event => { setQuery(event.target.value); setActive(-1); }} onKeyDown={keydown}/>
            <button type="button" className="icon-button" aria-label="Close search" onClick={() => setOpen(false)}><X size={20}/></button>
          </div>
          <div className="search-palette__results" role="listbox" id={listId} aria-label="Search results">
            {results.map((result, index) => <button type="button" className="search-palette__result" role="option" tabIndex={-1} aria-selected={index === active} id={`${listId}-${index}`} key={result.id} onMouseDown={event => event.preventDefault()} onClick={() => choose(result)}><span><strong>{result.title}</strong><small>{result.detail}</small></span><ArrowUpRight size={16} aria-hidden="true"/></button>)}
            {!results.length && <p className="search-palette__empty" role="status">{query.trim() ? 'No matches. Try another search.' : 'Local records, pages & work recipes'}</p>}
          </div>
          <div className="search-palette__footer"><span><kbd>↑</kbd> <kbd>↓</kbd> Navigate</span><span><kbd>↵</kbd> Open</span><span><kbd>Esc</kbd> Close</span></div>
        </section>
      </div>, document.body
    )}
  </>;
}
