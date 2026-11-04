import { useState, useSyncExternalStore } from 'react';
import { ArrowLeft, ArrowRight, FolderOpen, LogOut, Plus, Sparkles } from 'lucide-react';
import Brand from './Brand.jsx';
import { useWorkspace } from './store.jsx';
import { projectDisplayLabels } from './portfolio.js';
import { getRagChatSession, selectSessionProject, signOutSession, subscribeRagChatSession } from './rag-chat-session.js';
import { buildProjectContext } from './rag-chat-context.js';
import { createAiProject } from './linked-project.js';
import { projectDetailsFromServerProject, unlinkedServerProjects } from './onboarding.js';
import { FIELDS, STAGES, TYPES } from './project-fields.js';
import './onboarding.css';

const STEPS = ['Project', 'Stage', 'Next step'];
const BLANK_ANSWERS = { name: '', description: '', stage: 'Idea', productType: '', audience: '', goal: '' };

function TextField({ name, value, onChange, rows = 3, autoFocus = false }) {
  const [label, placeholder] = FIELDS[name];
  return <label className="field" htmlFor={`onboarding-${name}`}>
    <span>{label}</span>
    <textarea id={`onboarding-${name}`} rows={rows} value={value} placeholder={placeholder} autoFocus={autoFocus} onChange={event => onChange(name, event.target.value)}/>
  </label>;
}

function SelectField({ name, value, onChange, options, allowEmpty = true, autoFocus = false }) {
  const [label] = FIELDS[name];
  return <label className="field" htmlFor={`onboarding-${name}`}>
    <span>{label}</span>
    <select id={`onboarding-${name}`} value={value} autoFocus={autoFocus} onChange={event => onChange(name, event.target.value)}>
      {allowEmpty && <option value="">Not specified</option>}
      {options.map(option => <option key={option} value={option}>{option}</option>)}
    </select>
  </label>;
}

export default function Onboarding({ mode, onCancel, onBusyChange }) {
  const { projects, createProject, linkServerProject, switchProject, go, hasPreviousWorkspace } = useWorkspace();
  const session = useSyncExternalStore(subscribeRagChatSession, getRagChatSession);
  const [step, setStep] = useState(null);
  const [answers, setAnswers] = useState(BLANK_ANSWERS);
  const [nameError, setNameError] = useState('');
  const [busy, setBusy] = useState(false);
  // The mode is fixed when the setup opens; creating the project must not switch it mid-flow.
  const [firstRun] = useState(mode === 'first-run');
  const localChoices = firstRun ? projects : [];
  const aiChoices = firstRun ? unlinkedServerProjects(projects, session.projects) : [];
  const hasChoices = localChoices.length > 0 || aiChoices.length > 0;
  const currentStep = step ?? (hasChoices ? 0 : 1);
  const labels = projectDisplayLabels(localChoices);

  function change(key, value) {
    if (step === null) setStep(currentStep);
    if (key === 'name') setNameError('');
    setAnswers(previous => ({ ...previous, [key]: value }));
  }

  function submitName(event) {
    event.preventDefault();
    if (!answers.name.trim()) {
      setNameError('Enter a project name.');
      event.currentTarget.elements.namedItem('name')?.focus();
      return;
    }
    setStep(2);
  }

  async function createNewProject(event) {
    event.preventDefault();
    if (busy) return;
    const name = answers.name.trim();
    if (!name) {
      setStep(1);
      setNameError('Enter a project name.');
      return;
    }
    const details = { description: answers.description, stage: answers.stage, productType: answers.productType, audience: answers.audience, goal: answers.goal };
    setBusy(true);
    onBusyChange?.(true);
    // Local first: a storage failure leaves no server project behind, and a
    // failed AI project is retried from the AI panel without duplicates.
    const id = createProject(name, details);
    if (!id) {
      setBusy(false);
      onBusyChange?.(false);
      return;
    }
    const context = buildProjectContext(id, { ...details, name }, []).context;
    const serverProjectId = session.authenticated ? await createAiProject(context) : null;
    if (serverProjectId) linkServerProject(id, serverProjectId);
    onBusyChange?.(false);
    go('/overview');
  }

  function continueAiProject(serverProject) {
    if (!createProject(serverProject.name, projectDetailsFromServerProject(serverProject), serverProject.id)) return;
    void selectSessionProject(serverProject.id);
    go('/overview');
  }

  function openLocalProject(id) {
    if (switchProject(id)) go('/overview');
  }

  function signOut() {
    signOutSession();
    go('/overview');
  }

  const back = currentStep === 1
    ? hasChoices
      ? <button type="button" className="button secondary" onClick={() => setStep(0)}><ArrowLeft size={16} aria-hidden="true"/>Back</button>
      : !firstRun && <button type="button" className="button secondary" onClick={onCancel}>Cancel</button>
    : <button type="button" className="button secondary" onClick={() => setStep(currentStep - 1)} disabled={busy}><ArrowLeft size={16} aria-hidden="true"/>Back</button>;

  return <div className="onboarding">
    <header className="onboarding__header">
      <span className="onboarding__brand"><Brand size={24} wordmark/></span>
      {session.authenticated && <div className="onboarding__account">
        {(session.displayName || session.loginName) && <span className="onboarding__login">{session.displayName || session.loginName}</span>}
        {session.roles?.includes('admin') && <a className="button ghost onboarding__admin-link" href="#/admin" aria-disabled={busy ? 'true' : undefined} tabIndex={busy ? -1 : undefined} onClick={event => { if (busy) event.preventDefault(); }}>Administration</a>}
        <button type="button" className="button ghost" onClick={signOut} disabled={busy}><LogOut size={16} aria-hidden="true"/>Sign out</button>
      </div>}
    </header>
    <main className="onboarding__main">
      <div className="onboarding__layout">
        <aside className="onboarding__story">
          <p className="onboarding__eyebrow">{firstRun ? 'Welcome to hardviser' : 'New project'}</p>
          <h1>{firstRun ? 'Set up your first project' : 'Set up a new project'}</h1>
          <p className="onboarding__story-copy">Your answers become the project brief and the context for AI Cofounder. You can change them later.</p>
          {currentStep > 0 && <ol className="onboarding__steps" aria-label="Setup steps">
            {STEPS.map((label, index) => <li key={label} aria-current={currentStep === index + 1 ? 'step' : undefined} data-done={currentStep > index + 1 || undefined}>
              <span aria-hidden="true">{index + 1}</span>{label}
            </li>)}
          </ol>}
        </aside>
        <section className="onboarding__card" aria-labelledby="onboarding-step-title">
          {firstRun && hasPreviousWorkspace && <div className="notice"><span>Previous shared browser data has been preserved without assigning it to an account. <a href="#/settings/access">Export and recover previous data</a>.</span></div>}
          {currentStep === 0 && <>
            <h2 id="onboarding-step-title">How do you want to start?</h2>
            <button type="button" className="button primary onboarding__start" onClick={() => setStep(1)} autoFocus><Plus size={16} aria-hidden="true"/>Start a new project</button>
            {localChoices.length > 0 && <div className="onboarding__group">
              <h3>This account’s projects in this browser</h3>
              <ul className="onboarding__choices">
                {localChoices.map(project => <li key={project.id}>
                  <button type="button" className="onboarding__choice" onClick={() => openLocalProject(project.id)}>
                    <FolderOpen size={18} aria-hidden="true"/>
                    <span><strong>{labels.get(project.id)}</strong><small>{project.stage || 'Stage not specified'}</small></span>
                    <span className="onboarding__choice-action">Open</span>
                  </button>
                </li>)}
              </ul>
            </div>}
            {aiChoices.length > 0 && <div className="onboarding__group">
              <h3>AI projects in your account</h3>
              <ul className="onboarding__choices">
                {aiChoices.map(project => <li key={project.id}>
                  <button type="button" className="onboarding__choice" onClick={() => continueAiProject(project)}>
                    <Sparkles size={18} aria-hidden="true"/>
                    <span><strong>{project.name}</strong><small>Uses its saved brief</small></span>
                    <span className="onboarding__choice-action">Continue</span>
                  </button>
                </li>)}
              </ul>
            </div>}
            <a className="onboarding__restore" href="#/settings/access">Restore from a backup</a>
          </>}

          {currentStep === 1 && <form className="onboarding__form" onSubmit={submitName} noValidate>
            <p className="onboarding__progress">Step 1 of 3</p>
            <h2 id="onboarding-step-title">Name your project</h2>
            <label className="field" htmlFor="onboarding-name">
              <span>Project name *</span>
              <input
                id="onboarding-name"
                name="name"
                autoComplete="off"
                maxLength={120}
                autoFocus
                value={answers.name}
                placeholder={FIELDS.name[1]}
                onChange={event => change('name', event.target.value)}
                aria-invalid={nameError ? true : undefined}
                aria-describedby={nameError ? 'onboarding-name-error' : undefined}
              />
            </label>
            {nameError && <p className="onboarding__error" id="onboarding-name-error" role="alert">{nameError}</p>}
            <TextField name="description" value={answers.description} onChange={change} rows={4}/>
            <div className="onboarding__actions">{back}<button type="submit" className="button primary">Continue<ArrowRight size={16} aria-hidden="true"/></button></div>
          </form>}

          {currentStep === 2 && <form className="onboarding__form" onSubmit={event => { event.preventDefault(); setStep(3); }}>
            <p className="onboarding__progress">Step 2 of 3</p>
            <h2 id="onboarding-step-title">Where are you now?</h2>
            <SelectField name="stage" value={answers.stage} onChange={change} options={STAGES} allowEmpty={false} autoFocus/>
            <SelectField name="productType" value={answers.productType} onChange={change} options={TYPES}/>
            <TextField name="audience" value={answers.audience} onChange={change}/>
            <div className="onboarding__actions">{back}<button type="submit" className="button primary">Continue<ArrowRight size={16} aria-hidden="true"/></button></div>
          </form>}

          {currentStep === 3 && <form className="onboarding__form" onSubmit={createNewProject} aria-busy={busy}>
            <p className="onboarding__progress">Step 3 of 3</p>
            <h2 id="onboarding-step-title">What should happen next?</h2>
            <TextField name="goal" value={answers.goal} onChange={change} rows={4} autoFocus/>
            <div className="onboarding__actions">{back}<button type="submit" className="button primary" disabled={busy} aria-busy={busy}>{busy ? 'Creating project…' : 'Create project'}</button></div>
          </form>}
        </section>
      </div>
    </main>
  </div>;
}
