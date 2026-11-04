import { useEffect, useRef, useState } from 'react';

const TURNSTILE_SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let turnstileLoad = null;

function loadTurnstile() {
  if (globalThis.turnstile?.render) return Promise.resolve(globalThis.turnstile);
  if (turnstileLoad) return turnstileLoad;
  turnstileLoad = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = TURNSTILE_SCRIPT;
    script.async = true;
    script.defer = true;
    script.dataset.hardviserTurnstile = 'true';
    script.onload = () => {
      if (globalThis.turnstile?.render) resolve(globalThis.turnstile);
      else reject(new Error('Turnstile did not initialize.'));
    };
    script.onerror = () => reject(new Error('Turnstile could not be loaded.'));
    document.head.appendChild(script);
  }).catch(error => {
    turnstileLoad = null;
    throw error;
  });
  return turnstileLoad;
}

export default function TurnstileWidget({ onTokenChange, resetKey = 0, theme = 'light' }) {
  const siteKey = import.meta.env?.VITE_TURNSTILE_SITE_KEY || '';
  const container = useRef(null);
  const onTokenChangeRef = useRef(onTokenChange);
  const widgetRef = useRef(null);
  const [status, setStatus] = useState(siteKey ? 'loading' : 'unavailable');
  const [attempt, setAttempt] = useState(0);

  onTokenChangeRef.current = onTokenChange;

  useEffect(() => {
    if (!siteKey) {
      setStatus('unavailable');
      onTokenChangeRef.current('');
      return undefined;
    }
    let cancelled = false;
    let api = null;
    setStatus('loading');
    onTokenChangeRef.current('');

    loadTurnstile().then(turnstile => {
      if (cancelled || !container.current) return;
      api = turnstile;
      container.current.replaceChildren();
      widgetRef.current = turnstile.render(container.current, {
        sitekey: siteKey,
        action: 'email_login',
        theme,
        callback: token => {
          if (cancelled) return;
          onTokenChangeRef.current(typeof token === 'string' ? token : '');
          setStatus('verified');
        },
        'expired-callback': () => {
          if (cancelled) return;
          onTokenChangeRef.current('');
          setStatus('expired');
        },
        'error-callback': () => {
          if (cancelled) return;
          onTokenChangeRef.current('');
          setStatus('error');
        },
        'timeout-callback': () => {
          if (cancelled) return;
          onTokenChangeRef.current('');
          setStatus('expired');
        },
      });
      setStatus('waiting');
    }).catch(() => {
      if (cancelled) return;
      onTokenChangeRef.current('');
      setStatus('error');
    });

    return () => {
      cancelled = true;
      onTokenChangeRef.current('');
      if (widgetRef.current && api) api.remove(widgetRef.current);
      widgetRef.current = null;
      container.current?.replaceChildren();
    };
  }, [attempt, resetKey, siteKey, theme]);

  const statusMessage = status === 'unavailable'
    ? 'Email sign-in verification is not configured.'
    : status === 'loading'
      ? 'Loading the security check…'
      : status === 'verified'
        ? 'Security check complete.'
        : status === 'expired'
          ? 'The security check expired. Complete it again to continue.'
          : status === 'error'
            ? 'The security check could not load or complete. Try again.'
            : 'Complete the security check to request a sign-in link.';

  return <div className="dashboard-login__turnstile">
    <div className="dashboard-login__turnstile-widget" ref={container} aria-label="Security verification" />
    <p className={status === 'error' || status === 'unavailable' ? 'dashboard-login__turnstile-error' : ''} role="status" aria-live="polite">{statusMessage}</p>
    {status === 'error' && siteKey && <button className="dashboard-login__turnstile-retry" type="button" onClick={() => setAttempt(value => value + 1)}>Retry security check</button>}
  </div>;
}
