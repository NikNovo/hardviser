import React, { useRef, useState, useSyncExternalStore } from 'react';
import { ArrowUpRight, ArrowRight, Check, Download, FileText } from 'lucide-react';
import { useWorkspace } from './store.jsx';
import { recordLink } from './GlobalSearch.jsx';
import { AXES, scoreAxis } from './readiness.js';
import { downloadText } from './storage.js';
import SectionHeader from './SectionHeader.jsx';
import ProjectTodos from './ProjectTodos.jsx';
import { getRagChatSession, subscribeRagChatSession } from './rag-chat-session.js';
import { FIELDS } from './project-fields.js';
import './project-pages.css';

const RISKS = ['Wireless connectivity', 'Batteries', 'Medical use', 'Use by children', 'Food contact', 'High temperatures / energy', 'Personal data', 'Not sure yet'];
function Field({ name, value, onChange, required = false }) {
  const [label, placeholder, type, options] = FIELDS[name];
  const props = { id: name, name, value: value ?? '', onChange: e => onChange(name, e.target.value), required, placeholder };
  return <label className={'field ' + (type === 'textarea' ? 'field-wide' : '')} htmlFor={name}><span>{label}{required ? ' *' : ''}</span>{type === 'textarea' ? <textarea {...props} rows={3} /> : type === 'select' ? <select {...props}><option value="">Not specified</option>{options.map(v => <option key={v}>{v}</option>)}</select> : <input {...props} type={type || 'text'} min={type === 'number' ? 0 : undefined} step={type === 'number' ? 'any' : undefined} />}</label>;
}
function RiskFields({ value = [], onChange }) {
  const selected = Array.isArray(value) ? value : [];
  return <fieldset className="risk-fields"><legend>Topics to discuss with a specialist</legend><p className="muted">Flags for further investigation, not a legal classification of your product.</p><div className="chips">{RISKS.map(v => <label className={'chip ' + (selected.includes(v) ? 'selected' : '')} key={v}><input type="checkbox" checked={selected.includes(v)} onChange={() => onChange('riskFlags', selected.includes(v) ? selected.filter(x => x !== v) : [...selected, v])} />{v}</label>)}</div></fieldset>;
}
export function Passport() {
  const { project, updateProject, notify, go } = useWorkspace();
  const [draft, setDraft] = useState(project);
  const change = (key, value) => setDraft(old => ({ ...old, [key]: value }));
  function save(e) { e.preventDefault(); if (!draft.name.trim()) return; if (updateProject(draft)) notify('Project brief saved.'); }
  return <div className="project-passport"><SectionHeader section="PROJECT / CONTEXT" title="Project brief" description="Add what you know; leave unknown fields blank." /><div className="notice project-brief-note">Founder-entered context; not independently verified.</div><form className="panel project-brief-form" onSubmit={save}><div className="form-grid">{Object.keys(FIELDS).map(key => <Field key={key} name={key} value={draft[key]} onChange={change} required={key === 'name'} />)}</div><RiskFields value={draft.riskFlags} onChange={change} /><div className="form-actions"><button className="button primary" type="submit">Save project brief <Check size={16} /></button><button className="button secondary" type="button" onClick={() => go('/project/readiness')}>Open readiness check</button></div></form></div>;
}
const SERVER_BRIEF_FIELDS = [
  ['description', 'Product and problem'],
  ['audience', 'Audience'],
  ['markets', 'Markets'],
  ['team', 'Team'],
  ['goal', 'Next milestone'],
  ['notes', 'Existing context / notes'],
];

function ServerProjectOverview() {
  const session = useSyncExternalStore(subscribeRagChatSession, getRagChatSession);
  const { linkedServerProjectId } = useWorkspace();
  const serverProject = session.authenticated
    ? session.projects.find(project => project.id === session.selectedProjectId) || null
    : null;
  const briefFields = serverProject?.brief_fields && typeof serverProject.brief_fields === 'object'
    ? serverProject.brief_fields
    : {};
  const hasStructuredBrief = SERVER_BRIEF_FIELDS.some(([key]) => typeof briefFields[key] === 'string' && briefFields[key].trim());
  const savedBriefFields = serverProject
    ? SERVER_BRIEF_FIELDS
      .map(([key, label]) => [label, typeof briefFields[key] === 'string' ? briefFields[key] : ''])
      .filter(([, text]) => text.trim())
    : [];
  const legacyBrief = serverProject && !hasStructuredBrief && typeof serverProject.brief_text === 'string'
    ? serverProject.brief_text
    : '';

  return (
    <section className="panel server-project-overview project-server-overview" aria-label="Server project brief and tasks">
      <div className="server-project-overview__identity">
        <p className="rag-chat-label">AI COFOUNDER / SERVER PROJECT</p>
        <h2>{serverProject?.name || 'No AI project selected'}</h2>
        {serverProject && serverProject.id !== linkedServerProjectId && <p className="server-project-overview__scope">This AI project is not linked to the current project.</p>}
        {!serverProject && <p>Open or create the AI project in the AI Cofounder panel.</p>}
      </div>
      {serverProject && (
        <>
          <div className="server-project-overview__brief">
            <h3>Server project brief</h3>
            {savedBriefFields.length > 0 ? (
              <dl>{savedBriefFields.map(([label, text]) => <div key={label}><dt>{label}</dt><dd>{text}</dd></div>)}</dl>
            ) : legacyBrief ? (
              <dl><div><dt>Existing context</dt><dd>{legacyBrief}</dd></div></dl>
            ) : (
              <p className="muted">No saved brief fields yet.</p>
            )}
          </div>
          <ProjectTodos projectId={serverProject.id} />
        </>
      )}
    </section>
  );
}
 
export function Overview() {
  const { state, project, records, go } = useWorkspace();
  const works = records.filter(r => r.type === 'work');
  const otherRecords = records.filter(r => r.type !== 'work');
  const filled = ['name', 'description', 'audience', 'markets', 'team', 'goal'].filter(k => project[k]?.trim()).length;
  const recent = records.slice(0, 5);
  const nextActions = [
    ['Plan your first prototype', 'Which sample will answer your biggest technical question?', '/work/new/prototype-plan'],
    ['Prepare a supplier request', 'Bring requirements and files into a comparable RFQ package.', '/work/new/rfq'],
    ['Capture an observation', 'Keep your insight with its interview, measurement or source.', '/library/evidence']
  ];
  const statusLabel = value => ({ draft: 'Draft', ready: 'Brief prepared', cancelled: 'Cancelled' }[value] || value);
  return (
    <div className="project-overview">
      <SectionHeader section="PROJECT" title="Overview" description="Current project context, readiness, and recent records." />
      <ServerProjectOverview />
      <dl className="overview-summary">
        <div><dt>Brief fields</dt><dd>{filled} / 6</dd></div>
        <div><dt>Requests</dt><dd>{works.length}</dd></div>
        <div><dt>Records</dt><dd>{otherRecords.length}</dd></div>
        <div><dt>Stage</dt><dd>{project.stage || 'Not specified'}</dd></div>
      </dl>
      <div className="overview-grid">
        <div>
          <section className="panel overview-details">
            <div className="overview-panel__header">
              <div><h2>Project details</h2></div>
              <button className={`button ${filled <= 1 ? 'primary' : 'secondary'}`} onClick={() => go('/project/passport')}>
                {filled <= 1 ? 'Complete brief' : 'Edit brief'} <ArrowUpRight size={16} />
              </button>
            </div>
            <dl className="project-properties">
              {[['Name', project.name], ['Product type', project.productType], ['Audience', project.audience], ['Target markets', project.markets], ['Description', project.description]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value || 'Not specified'}</dd></div>)}
            </dl>
          </section>
          <section className="panel panel--quiet overview-actions">
            <div className="overview-panel__header"><div><h2>Next actions</h2></div></div>
            <div className="task-list">
              {nextActions.map(([title, desc, path], i) => (
                <button className="task-row" key={path} onClick={() => go(path)}>
                  <span className="task-row__index">{i + 1}</span>
                  <span className="task-row__content"><strong>{title}</strong><span>{desc}</span></span>
                  <ArrowUpRight size={18} />
                </button>
              ))}
            </div>
          </section>
        </div>
        <div>
          <section className="panel overview-readiness">
            <div className="overview-panel__header"><div><h2>Readiness by area</h2></div><button className="button ghost" aria-label="Open readiness check" onClick={() => go('/project/readiness')}><ArrowUpRight size={16} /></button></div>
            {AXES.map(a => {
              const s = scoreAxis(a, state.answers);
              return <div className="readiness-bar" key={a.id}>
                <div className="readiness-bar__head"><strong>{a.title}</strong><span className={s.percent === null ? '' : 'readiness-score'}>{s.percent === null ? 'Not assessed' : `${s.percent}%`}</span></div>
                <div className="progress-track"><span className="progress-fill" style={{ width: `${s.percent ?? 0}%` }} /></div>
                <small className="muted">{s.answered} of {s.applicable} applicable answered</small>
              </div>;
            })}
          </section>
          <section className="panel overview-recent">
            <div className="overview-panel__header"><div><h2>Recent records</h2></div><button className="button ghost" aria-label="Open library" onClick={() => go('/library')}><ArrowUpRight size={16} /></button></div>
            {recent.length ? recent.map(r => <button className="recent-row" key={r.id} onClick={() => go(recordLink(r))}><FileText size={18} /><div><strong>{r.title}</strong><small>{statusLabel(r.status)} · {new Date(r.updatedAt).toLocaleDateString('en-US')}</small></div><ArrowUpRight size={16} /></button>) : <p className="muted">No records yet.</p>}
          </section>
        </div>
      </div>
    </div>
  );
}
 
export function Readiness() {
  const { state, records, updateAnswers, go } = useWorkspace();
  const [axisIndex, setAxisIndex] = useState(0);
  const axis = AXES[axisIndex];
  const firstQuestionRef = useRef(null);
  const hasSavedAnswers = AXES.some(area => area.questions.some(question => Boolean(state.answers[question.id]?.value)));
  function change(id, patch) {
    const answer = { ...(state.answers[id] || {}), ...patch };
    if (patch.value && patch.value !== 'na') answer.reason = '';
    updateAnswers({ [id]: answer });
  }

  function startAssessment() {
    setAxisIndex(0);
    window.requestAnimationFrame(() => firstQuestionRef.current?.querySelector('input[value="unknown"]')?.focus());
  }
  function exportAnswers() {
    const text = '# Hardviser readiness check\n\nA self-assessment, not a forecast of success.\n\n' + AXES.map(a => { const s=scoreAxis(a,state.answers); return `## ${a.title}\n${s.percent===null?'Not assessed':s.percent+'%'}; answered ${s.answered}/${s.applicable}\n\n` + a.questions.map(q => { const ans=state.answers[q.id]||{};return `### ${q.text}\nAnswer: ${ans.value === 'na' ? 'Not applicable' : ans.value === undefined || ans.value === 'unknown' ? 'Not sure yet' : q.levels[Number(ans.value)]}\nReason: ${ans.value === 'na' ? ans.reason||'—' : '—'}\nSource: ${ans.evidence ? records.find(r=>r.id===ans.evidence)?.title||'Source unavailable' : 'Not attached'}\n`; }).join('\n'); }).join('\n');
    downloadText(text, 'hardviser-readiness.md');
  }
  return (
    <div className="project-readiness">
      <SectionHeader
        section="PROJECT / OPTIONAL ASSESSMENT"
        title="Readiness"
        description="15 questions across five areas. This self-assessment is not a forecast."
        actions={<button className="button secondary" onClick={exportAnswers}><Download size={16} />Download answers</button>}
      />
      <div className="tabs" role="tablist" aria-label="Readiness areas">
        {AXES.map((a, i) => <button className={'tab ' + (i === axisIndex ? 'active' : '')} role="tab" aria-selected={i === axisIndex} key={a.id} onClick={() => setAxisIndex(i)}>{a.title}</button>)}
      </div>
      <div className="notice readiness-note">Score = points / (3 × answered 0–3 responses); coverage is shown separately. Unknown is not scored; not applicable is excluded only with an explanation.</div>
      {!hasSavedAnswers && (
        <section className="empty-state compact readiness-start">
          <h2>No readiness answers yet</h2>
          <p>Begin with the Demand questions.</p>
          <button type="button" className="button primary" onClick={startAssessment}>
            Start assessment <ArrowRight size={16} />
          </button>
        </section>
      )}
      {axis.questions.map((q, i) => {
        const a = state.answers[q.id] || {};
        return (
          <section className="question" key={q.id} ref={axisIndex === 0 && i === 0 ? firstQuestionRef : null}>
            <span className="eyebrow">QUESTION {axisIndex * 3 + i + 1} / 15</span>
            <h2>{q.text}</h2>
            <div className="option-grid">
              {q.levels.map((label, v) => <label className={'choice ' + (a.value === String(v) ? 'selected' : '')} key={v}>
                <input type="radio" name={q.id} value={v} checked={a.value === String(v)} onChange={() => change(q.id, { value: String(v) })} />
                <span><strong>{v}</strong>{label}</span>
              </label>)}
            </div>
            <div className="chips">
              <label className="chip"><input type="radio" name={q.id} value="unknown" checked={!a.value || a.value === 'unknown'} onChange={() => change(q.id, { value: 'unknown' })} />Not sure yet</label>
              <label className="chip"><input type="radio" name={q.id} value="na" checked={a.value === 'na'} onChange={() => change(q.id, { value: 'na' })} />Not applicable</label>
            </div>
            {a.value === 'na' && <label className="field"><span>Why is this not applicable? Required to exclude it from coverage.</span><textarea value={a.reason || ''} onChange={e => change(q.id, { reason: e.target.value })} rows={2} />{!a.reason?.trim() && <small>Without an explanation, this question is treated as unknown.</small>}</label>}
            <label className="field"><span>Supporting material</span><select value={a.evidence || ''} onChange={e => change(q.id, { evidence: e.target.value })}><option value="">No source — self-assessment only</option>{records.filter(r => r.type !== 'work').map(r => <option value={r.id} key={r.id}>{r.title}</option>)}</select></label>
            <p className="muted">If this is a gap: {q.next}</p>
          </section>
        );
      })}
      <section className="panel readiness-summary">
        <h2>{axis.title}: your assessment</h2>
        {(() => { const s = scoreAxis(axis, state.answers); return <p><strong>{s.percent === null ? 'Not enough answers' : `${s.percent}% across answered questions`}</strong> · {s.answered}/{s.applicable} applicable questions answered · {s.evidence} with a source. A linked source is not independent verification.</p>; })()}
        <div className="form-actions">
          {axisIndex > 0 && <button className="button secondary" onClick={() => setAxisIndex(axisIndex - 1)}>Back</button>}
          {axisIndex < 4
            ? <button className="button primary" onClick={() => { setAxisIndex(axisIndex + 1); document.getElementById('main-content')?.scrollTo(0, 0); }}>Next area <ArrowRight size={16} /></button>
            : <button className="button primary" onClick={() => go('/overview')}>Return to project <Check size={16} /></button>}
        </div>
      </section>
    </div>
  );
}

