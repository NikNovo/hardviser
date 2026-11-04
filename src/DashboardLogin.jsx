import { useEffect, useState, useSyncExternalStore } from 'react';
import { prepareEmailLogin, requestEmailLogin } from './rag-chat-api.js';
import { consumeSessionEmailLogin } from './rag-chat-session.js';
import TurnstileWidget from './TurnstileWidget.jsx';
import Brand from './Brand.jsx';
import { getAppearanceSnapshot, subscribeAppearance } from './appearance.js';
import './dashboard-login.css';

const LEGAL_LINKS = [
  ['Code of Conduct', '/legal/code-of-conduct'],
  ['NDA', '/legal/nda'],
  ['Terms', '/legal/terms'],
  ['Privacy', '/legal/privacy'],
  ['Intellectual property', '/legal/ip'],
];

function isSafeEmailReturnPath(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 512
    && value.startsWith('/')
    && !value.startsWith('//')
    && !value.includes('\\')
    && !value.includes('#')
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function currentEmailReturnPath() {
  const route = window.location.hash.slice(1) || '/overview';
  return isSafeEmailReturnPath(route) ? route : '/overview';
}

function removeEmailTokenFromUrl() {
  const route = window.location.hash.slice(1);
  const queryStart = route.indexOf('?');
  if (queryStart < 0) return;
  const path = route.slice(0, queryStart) || '/auth/email';
  const params = new URLSearchParams(route.slice(queryStart + 1));
  if (!params.has('token')) return;
  params.delete('token');
  const query = params.toString();
  const nextRoute = `${path}${query ? `?${query}` : ''}`;
  window.history.replaceState(
    window.history.state,
    '',
    `${window.location.pathname}${window.location.search}#${nextRoute}`,
  );
}

function EmailLoginForm({ theme }) {
  const [email, setEmail] = useState('');
  const [sentEmail, setSentEmail] = useState('');
  const [mode, setMode] = useState('request');
  const [turnstileToken, setTurnstileToken] = useState('');
  const [turnstileResetKey, setTurnstileResetKey] = useState(0);
  const [requestPending, setRequestPending] = useState(false);
  const [requestError, setRequestError] = useState('');
  const [emailError, setEmailError] = useState('');
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [cooldownSeconds, setCooldownSeconds] = useState(0);

  useEffect(() => {
    if (!cooldownUntil) {
      setCooldownSeconds(0);
      return undefined;
    }
    const updateCooldown = () => {
      const remaining = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
      setCooldownSeconds(remaining);
      if (remaining === 0) setCooldownUntil(0);
    };
    updateCooldown();
    const timer = setInterval(updateCooldown, 1000);
    return () => clearInterval(timer);
  }, [cooldownUntil]);

  async function requestLink(event) {
    event.preventDefault();
    const emailInput = event.currentTarget.elements.namedItem('email');
    if (emailInput && !emailInput.checkValidity()) {
      setEmailError(emailInput.value.trim() ? 'Enter a valid email address.' : 'Enter your email address.');
      emailInput.focus();
      return;
    }
    const address = (emailInput?.value ?? email).trim();
    if (requestPending || cooldownSeconds > 0 || !address || !turnstileToken) return;
    if (address !== email) setEmail(address);
    const challengeToken = turnstileToken;
    setRequestPending(true);
    setRequestError('');
    setTurnstileToken('');
    setTurnstileResetKey(key => key + 1);
    try {
      await requestEmailLogin(address, challengeToken, currentEmailReturnPath());
      setSentEmail(address);
      setMode('inbox');
      setCooldownUntil(Date.now() + 60_000);
      setCooldownSeconds(60);
    } catch (error) {
      setRequestError(error.status === 429
        ? 'Please wait before requesting another sign-in link, then try again.'
        : error.status === 403
          ? 'The security check could not be verified. Complete it again and retry.'
          : 'We could not request a sign-in link. Check your connection and try again.');
      if (error.status === 429) {
        setCooldownUntil(Date.now() + 60_000);
        setCooldownSeconds(60);
      }
    } finally {
      setRequestPending(false);
      setTurnstileToken('');
    }
  }

  function changeEmail() {
    setMode('request');
    setSentEmail('');
    setRequestError('');
    setCooldownUntil(0);
    setCooldownSeconds(0);
    setTurnstileToken('');
    setTurnstileResetKey(key => key + 1);
  }

  return <section className="dashboard-login__card" aria-labelledby="dashboard-login-title">
    <p className="dashboard-login__eyebrow">Server account</p>
    <h1 id="dashboard-login-title">Sign in</h1>
    {mode === 'inbox' ? <>
      <p className="dashboard-login__intro">If this address can be used to sign in, an email with a link will arrive shortly.</p>
      <div className="dashboard-login__notice" role="status" aria-live="polite">
        <strong>Check your inbox</strong>
        <span>We sent a sign-in link for <b className="dashboard-login__email">{sentEmail}</b>. Check your spam folder if it does not arrive.</span>
      </div>
      {cooldownSeconds > 0
        ? <p className="dashboard-login__cooldown">You can request another link in {cooldownSeconds} seconds.</p>
        : <form className="dashboard-login__form" onSubmit={requestLink} aria-busy={requestPending}>
          <TurnstileWidget onTokenChange={setTurnstileToken} resetKey={turnstileResetKey} theme={theme}/>
          {requestError && <p className="dashboard-login__error" role="alert">{requestError}</p>}
          <button className="button primary dashboard-login__submit" type="submit" disabled={requestPending || !turnstileToken} aria-busy={requestPending}>
            {requestPending ? 'Sending link…' : 'Resend sign-in link'}
          </button>
        </form>}
      <button className="dashboard-login__switch" type="button" disabled={requestPending} onClick={changeEmail}>Use a different email address</button>
    </> : <>
      <p className="dashboard-login__intro">Sign in or create a server account with an email link.</p>
      <form className="dashboard-login__form" onSubmit={requestLink} aria-busy={requestPending} noValidate>
        <label className="dashboard-login__field" htmlFor="dashboard-login-email">
          <span>Email address *</span>
          <input
            id="dashboard-login-email"
            name="email"
            type="email"
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            required
            disabled={requestPending}
            value={email}
            onChange={event => { setEmail(event.target.value); setEmailError(''); }}
            aria-invalid={emailError ? true : undefined}
            aria-describedby={[emailError && 'dashboard-email-field-error', requestError && 'dashboard-email-login-error'].filter(Boolean).join(' ') || undefined}
          />
        </label>
        {emailError && <p className="dashboard-login__error" id="dashboard-email-field-error" role="alert">{emailError}</p>}
        {cooldownSeconds > 0 && <p className="dashboard-login__cooldown">Please wait {cooldownSeconds} seconds before requesting another link.</p>}
        {requestError && <p className="dashboard-login__error" id="dashboard-email-login-error" role="alert">{requestError}</p>}
        {cooldownSeconds === 0 && <TurnstileWidget onTokenChange={setTurnstileToken} resetKey={turnstileResetKey} theme={theme}/>}
        <button className="button primary dashboard-login__submit" type="submit" disabled={requestPending || cooldownSeconds > 0 || !turnstileToken} aria-busy={requestPending}>
          {requestPending ? 'Sending link…' : 'Email me a sign-in link'}
        </button>
      </form>
    </>}
  </section>;
}
function AuthStory() {
  return <aside className="dashboard-login__story" aria-label="Hardviser workspace">
    <p className="dashboard-login__story-eyebrow">Hardware project workspace</p>
    <h2>Your next decision starts here.</h2>
    <p className="dashboard-login__story-copy">Keep project context, engineering questions, and decisions connected.</p>
    <p className="dashboard-login__story-index"><span>Projects</span><span aria-hidden="true">/</span><span>Files</span><span aria-hidden="true">/</span><span>Decisions</span></p>
  </aside>;
}


export function EmailAuthConfirmation({ token, session }) {
  const [phase, setPhase] = useState(token ? 'preparing' : 'invalid');
  const [prepared, setPrepared] = useState(null);
  const [error, setError] = useState('');
  const [consumePending, setConsumePending] = useState(false);
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    if (!token) {
      setPhase('invalid');
      return undefined;
    }
    const controller = new AbortController();
    setPhase('preparing');
    setPrepared(null);
    setError('');
    prepareEmailLogin(token, controller.signal).then(data => {
      if (controller.signal.aborted) return;
      if (!isSafeEmailReturnPath(data.return_to)) {
        removeEmailTokenFromUrl();
        setPhase('invalid');
        return;
      }
      setPrepared(data);
      setPhase('ready');
    }).catch(requestError => {
      if (controller.signal.aborted) return;
      if (requestError.code === 'invalid_link') {
        removeEmailTokenFromUrl();
        setPhase('invalid');
      } else {
        setError('We could not verify this sign-in link. Check your connection and try again.');
        setPhase('error');
      }
    });
    return () => controller.abort();
  }, [retryCount, token]);

  async function continueWithEmail() {
    if (!token || !prepared || consumePending || (phase !== 'ready' && phase !== 'error')) return;
    setConsumePending(true);
    setError('');
    setPhase('consuming');
    try {
      const published = await consumeSessionEmailLogin(token);
      if (!published) {
        removeEmailTokenFromUrl();
        setError('This confirmation was interrupted. Request a new sign-in link and try again.');
        setPhase('interrupted');
        return;
      }
      removeEmailTokenFromUrl();
      window.location.hash = prepared.return_to;
    } catch (consumeError) {
      if (consumeError.code === 'invalid_link') {
        removeEmailTokenFromUrl();
        setPhase('invalid');
      } else {
        setError('We could not complete sign-in. Your current server session has not been changed. Try again or request a new link.');
        setPhase('error');
      }
    } finally {
      setConsumePending(false);
    }
  }

  return <section className="dashboard-login__card" aria-labelledby="dashboard-email-confirm-title">
    <p className="dashboard-login__eyebrow">Email sign-in</p>
    <h1 id="dashboard-email-confirm-title">Confirm sign-in</h1>
    {phase === 'preparing' && <p className="dashboard-login__checking" role="status" aria-live="polite">Checking this sign-in link…</p>}
    {phase === 'ready' && <>
      <p className="dashboard-login__intro">Continue only if you requested this sign-in. This link can be used once.</p>
      <p className="dashboard-login__confirmed-email">Continue as <strong className="dashboard-login__email">{prepared.email}</strong></p>
      {session.authenticated && <p className="dashboard-login__notice">Currently signed in as <strong className="dashboard-login__email">{session.loginName}</strong>. Continuing opens the confirmed account’s workspace. Other accounts’ saved local data stays separate.</p>}
      <button className="button primary dashboard-login__submit" type="button" onClick={continueWithEmail} disabled={consumePending} aria-busy={consumePending}>Continue to sign in</button>
    </>}
    {phase === 'consuming' && <p className="dashboard-login__checking" role="status" aria-live="polite">Signing in as {prepared?.email}…</p>}
    {phase === 'invalid' && <div className="dashboard-login__error" role="alert">
      <p>This sign-in link is invalid, expired, or already used. Your current server sign-in, if any, has not been changed.</p>
      <a href="#/overview">Return to sign-in</a>
    </div>}
    {phase === 'interrupted' && <div className="dashboard-login__error" role="alert">
      <p>{error}</p>
      <a href="#/overview">Return to sign-in</a>
    </div>}
    {phase === 'error' && <div className="dashboard-login__error" role="alert">
      <p>{error}</p>
      {!prepared && token && <button className="dashboard-login__retry" type="button" onClick={() => setRetryCount(value => value + 1)}>Try checking the link again</button>}
      {prepared && token && <button className="dashboard-login__retry" type="button" onClick={continueWithEmail} disabled={consumePending}>Try sign-in again</button>}
      <a href="#/overview">Return to sign-in</a>
    </div>}
  </section>;
}

export default function DashboardLogin({ checking = false, children }) {
  const appearance = useSyncExternalStore(subscribeAppearance, getAppearanceSnapshot);
  const showingEmailConfirmation = children?.type === EmailAuthConfirmation;
  const showingLegal = children != null && !showingEmailConfirmation;
  const authContent = showingEmailConfirmation ? children : <EmailLoginForm theme={appearance.theme}/>;

  return <div className="dashboard-login">
    <header className="dashboard-login__header">
      <a className="dashboard-login__brand" href="#/overview" aria-label="Hardviser sign in">
        <Brand size={24} wordmark/>
      </a>
      {showingLegal && <a className="dashboard-login__header-link" href="#/overview">Sign in</a>}
    </header>
    <main className={`dashboard-login__main${showingLegal ? ' dashboard-login__main--legal' : ''}`}>
      {checking
        ? <div className="dashboard-login__layout">
          <AuthStory/>
          <section className="dashboard-login__card" aria-labelledby="dashboard-session-check-title">
            <p className="dashboard-login__eyebrow">Server account</p>
            <h1 id="dashboard-session-check-title">Checking sign-in</h1>
            <p className="dashboard-login__checking" role="status" aria-live="polite">Checking your server sign-in…</p>
          </section>
        </div>
        : showingLegal
          ? <div className="dashboard-login__legal">{children}</div>
          : <div className="dashboard-login__layout">
            <AuthStory/>
            <div className="dashboard-login__content">{authContent}</div>
          </div>}
    </main>
    <footer className="dashboard-login__footer">
      <nav aria-label="Legal information">
        {LEGAL_LINKS.map(([label, path]) => <a key={path} href={`#${path}`}>{label}</a>)}
      </nav>
    </footer>
  </div>;
}
