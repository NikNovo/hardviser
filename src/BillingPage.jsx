import { useEffect, useRef, useState } from 'react';
import { getBillingStatus, syncBilling } from './rag-chat-api.js';
import { SANDBOX_BILLING_ENABLED } from './billing-config.js';
import { revenueCatCustomer } from './billing-sdk.js';
import { applyBillingSnapshot } from './billing-snapshot.js';
import './billing.css';

const PLANS = [
  { identifier: 'pro', label: 'Pro', productIdentifier: 'pro_monthly' },
  { identifier: 'ultra_pro', label: 'Ultra Pro', productIdentifier: 'ultra_pro_monthly' },
  { identifier: 'max', label: 'Max', productIdentifier: 'max_monthly' },
];
const VERIFICATION_LIMIT_MS = 30_000;
const VERIFICATION_RETRY_MS = 8_000;
function serverPlanLabel(plan) {
  if (plan === 'free') return 'Free';
  return PLANS.find(item => item.identifier === plan)?.label || 'Unavailable';
}

function serverErrorMessage(error) {
  if (error?.status === 401) return 'Your server sign-in expired. Sign in again to check billing.';
  if (error?.status === 503) return 'Sandbox billing is not available on the server yet. Ask the workspace administrator to finish the sandbox setup, then retry.';
  return 'The billing service could not verify this account. Check your connection and retry; existing access has not changed.';
}

function purchaseErrorMessage() {
  return 'The sandbox checkout could not complete. Check your connection and the RevenueCat sandbox setup, then try again. Server-verified access has not changed.';
}

function validManagementURL(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function formatTimestamp(value) {
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function waitForRetry(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const clear = () => signal.removeEventListener('abort', abort);
    const timer = setTimeout(() => {
      clear();
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      clear();
      const error = new Error('The billing page closed before verification finished.');
      error.name = 'AbortError';
      reject(error);
    };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

function offeringsForPlans(offerings) {
  const offering = offerings?.all?.plans;
  if (!offering) {
    throw new Error('The sandbox “plans” offering is missing. Ask the billing administrator to configure it in RevenueCat.');
  }
  if (!Array.isArray(offering.availablePackages)) {
    throw new Error('The sandbox “plans” offering returned no package list. Ask the billing administrator to check its RevenueCat configuration.');
  }
  return PLANS.map(plan => {
    const rcPackage = offering.availablePackages.find(item => item.identifier === plan.identifier);
    if (!rcPackage) {
      throw new Error(`The sandbox “plans” offering is missing the “${plan.identifier}” package. Ask the billing administrator to check its RevenueCat configuration.`);
    }
    if (rcPackage.product?.identifier !== plan.productIdentifier) {
      const actualProduct = rcPackage.product?.identifier || 'no product';
      throw new Error(`The “${plan.identifier}” package must use “${plan.productIdentifier}”; RevenueCat returned “${actualProduct}”. Ask the billing administrator to correct the sandbox offering.`);
    }
    if (rcPackage.product.period?.unit !== 'month' || rcPackage.product.period.number !== 1) {
      throw new Error(`The “${plan.identifier}” package must use a monthly product. Check “${plan.productIdentifier}” in the sandbox RevenueCat offering.`);
    }
    if (rcPackage.product.freeTrialPhase || rcPackage.product.introPricePhase || rcPackage.product.discountPhase) {
      throw new Error(`The “${plan.identifier}” sandbox package must not include a trial or promotional price. Check its RevenueCat product configuration.`);
    }
    const price = rcPackage.product.price?.formattedPrice;
    if (typeof price !== 'string' || !price.trim()) {
      throw new Error(`RevenueCat did not return a display price for “${plan.productIdentifier}”. Check the sandbox product setup and retry.`);
    }
    return { ...plan, rcPackage, price };
  });
}
async function loadSandboxOfferDetails(userId) {
  return revenueCatCustomer.run(userId, async purchases => {
    const offerings = await purchases.getOfferings();
    let portal = null;
    try {
      const customerInfo = await purchases.getCustomerInfo();
      portal = validManagementURL(customerInfo.managementURL);
    } catch {
      // CustomerInfo is used only for the optional portal URL, never for access.
    }
    return { plans: offeringsForPlans(offerings), portal };
  });
}

export default function BillingPage({ session }) {
  const userId = session.authenticated ? session.userId : null;
  const userIdRef = useRef(userId);
  userIdRef.current = userId;
  const generationRef = useRef(0);
  const verificationAttemptRef = useRef(0);
  const verificationRunningRef = useRef(false);
  const pendingPlanRef = useRef(null);
  const purchaseOperationRef = useRef(0);
  const purchaseRunningRef = useRef(false);
  const checkoutPendingRef = useRef(false);
  const contextResetScheduledRef = useRef(false);
  const beforeUnloadHandlerRef = useRef(null);
  const lifecycleRef = useRef(null);
  const [status, setStatus] = useState(null);
  const statusRef = useRef(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusError, setStatusError] = useState('');
  const [offers, setOffers] = useState([]);
  const [offersLoading, setOffersLoading] = useState(SANDBOX_BILLING_ENABLED);
  const [offersError, setOffersError] = useState('');
  const [managementURL, setManagementURL] = useState(null);
  const [purchaseBusyPlan, setPurchaseBusyPlan] = useState('');
  const [purchaseMessage, setPurchaseMessage] = useState('');
  const [purchaseError, setPurchaseError] = useState('');
  const [verification, setVerification] = useState(null);
  const [verificationRunning, setVerificationRunning] = useState(false);

  useEffect(() => {
    const generation = ++generationRef.current;
    const controller = new AbortController();
    const isCurrent = () => generationRef.current === generation
      && userIdRef.current === userId
      && !controller.signal.aborted;
    const leaveCustomer = SANDBOX_BILLING_ENABLED && userId
      ? revenueCatCustomer.activate(userId)
      : null;
    lifecycleRef.current = { userId, generation, controller, isCurrent };

    const cleanup = () => {
      const checkoutWasPending = checkoutPendingRef.current;
      if (checkoutWasPending) contextResetScheduledRef.current = true;
      const beforeUnloadHandler = beforeUnloadHandlerRef.current;
      if (beforeUnloadHandler && typeof window !== 'undefined') {
        window.removeEventListener('beforeunload', beforeUnloadHandler);
      }
      beforeUnloadHandlerRef.current = null;
      controller.abort();
      leaveCustomer?.();
      verificationAttemptRef.current += 1;
      verificationRunningRef.current = false;
      purchaseOperationRef.current += 1;
      if (generationRef.current === generation) generationRef.current += 1;
      if (lifecycleRef.current?.generation === generation) lifecycleRef.current = null;
      if (checkoutWasPending) {
        try {
          revenueCatCustomer.disposeForNavigation();
        } catch {
          // Reloading still discards the old SDK context if disposal fails.
        }
      }
      if (checkoutWasPending && typeof window !== 'undefined') window.location.reload();
    };

    statusRef.current = null;
    pendingPlanRef.current = null;
    verificationAttemptRef.current += 1;
    verificationRunningRef.current = false;
    purchaseOperationRef.current += 1;
    setStatus(null);
    setStatusError('');
    setStatusLoading(true);
    setOffers([]);
    setOffersError('');
    setOffersLoading(SANDBOX_BILLING_ENABLED);
    setManagementURL(null);
    setPurchaseBusyPlan('');
    setPurchaseMessage('');
    setPurchaseError('');
    setVerification(null);
    setVerificationRunning(false);

    if (!SANDBOX_BILLING_ENABLED || !userId) {
      setStatusLoading(false);
      setOffersLoading(false);
      return cleanup;
    }

    void getBillingStatus(controller.signal).then(snapshot => {
      if (!isCurrent()) return;
      statusRef.current = snapshot;
      setStatus(snapshot);
      setStatusError('');
    }).catch(error => {
      if (isCurrent()) setStatusError(serverErrorMessage(error));
    }).finally(() => {
      if (isCurrent()) setStatusLoading(false);
    });

    void loadSandboxOfferDetails(userId).then(result => {
      if (!isCurrent()) return;
      setOffers(result.plans);
      setManagementURL(result.portal);
      setOffersError('');
    }).catch(error => {
      if (!isCurrent() || error?.name === 'AbortError') return;
      setOffersError(error instanceof Error && error.message
        ? error.message
        : 'Sandbox offers could not be loaded. Check the RevenueCat setup and retry.');
    }).finally(() => {
      if (isCurrent()) setOffersLoading(false);
    });

    return cleanup;
  }, [userId]);
  async function retryOffers() {
    const lifecycle = lifecycleRef.current;
    if (!lifecycle || offersLoading || !lifecycle.isCurrent()) return;
    setOffersLoading(true);
    setOffersError('');
    try {
      const result = await loadSandboxOfferDetails(userId);
      if (!lifecycle.isCurrent()) return;
      setOffers(result.plans);
      setManagementURL(result.portal);
    } catch (error) {
      if (lifecycle.isCurrent() && error?.name !== 'AbortError') {
        setOffersError(error instanceof Error && error.message
          ? error.message
          : 'Sandbox offers could not be loaded. Check the RevenueCat setup and retry.');
      }
    } finally {
      if (lifecycle.isCurrent()) setOffersLoading(false);
    }
  }

  async function refreshStatus() {
    const lifecycle = lifecycleRef.current;
    if (!lifecycle || statusLoading || verificationRunningRef.current || !lifecycle.isCurrent()) return;
    setStatusLoading(true);
    setStatusError('');
    try {
      const snapshot = await getBillingStatus(lifecycle.controller.signal);
      if (!lifecycle.isCurrent()) return;
      const transition = applyBillingSnapshot(snapshot, pendingPlanRef.current);
      statusRef.current = transition.status;
      setStatus(transition.status);
      setStatusError('');
      pendingPlanRef.current = transition.pendingPlan;
      if (transition.verified) {
        setVerification({ state: 'verified', message: 'The server confirmed the current plan.' });
      }
    } catch (error) {
      if (lifecycle.isCurrent()) setStatusError(serverErrorMessage(error));
    } finally {
      if (lifecycle.isCurrent()) setStatusLoading(false);
    }
  }

  async function verifyWithServer(expectedPlan) {
    const lifecycle = lifecycleRef.current;
    if (!lifecycle || !lifecycle.isCurrent() || verificationRunningRef.current) return;
    const attempt = ++verificationAttemptRef.current;
    verificationRunningRef.current = true;
    pendingPlanRef.current = expectedPlan;
    setVerificationRunning(true);
    setVerification({
      state: 'pending',
      message: 'Checkout completed. Waiting for server verification; the displayed plan changes only when the server confirms it.',
    });
    const verificationController = new AbortController();
    const abortVerification = () => verificationController.abort();
    lifecycle.controller.signal.addEventListener('abort', abortVerification, { once: true });
    const verificationTimeout = setTimeout(abortVerification, VERIFICATION_LIMIT_MS);
    const deadline = Date.now() + VERIFICATION_LIMIT_MS;
    let lastAttemptFailed = false;
    try {
      while (Date.now() < deadline) {
        if (!lifecycle.isCurrent() || verificationAttemptRef.current !== attempt) return;
        try {
          const snapshot = await syncBilling(verificationController.signal);
          if (!lifecycle.isCurrent() || verificationAttemptRef.current !== attempt) return;
          lastAttemptFailed = false;
          const transition = applyBillingSnapshot(snapshot, expectedPlan);
          statusRef.current = transition.status;
          setStatus(transition.status);
          setStatusError('');
          pendingPlanRef.current = transition.pendingPlan;
          if (transition.verified) {
            setVerification({ state: 'verified', message: 'The server confirmed the current plan.' });
            return;
          }
        } catch (error) {
          if (!lifecycle.isCurrent() || verificationAttemptRef.current !== attempt) return;
          lastAttemptFailed = true;
          if (verificationController.signal.aborted || error?.name === 'AbortError') break;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await waitForRetry(Math.min(VERIFICATION_RETRY_MS, remaining), lifecycle.controller.signal);
      }
      if (!lifecycle.isCurrent() || verificationAttemptRef.current !== attempt) return;
      setVerification({
        state: 'pending',
        message: lastAttemptFailed
          ? 'The checkout completed, but the server could not refresh verification. Existing access remains unchanged. Retry server verification when the billing service is available.'
          : 'Server verification is still pending. No new access is shown until the server confirms it; retry verification shortly.',
      });
    } catch (error) {
      if (error?.name !== 'AbortError' && lifecycle.isCurrent() && verificationAttemptRef.current === attempt) {
        setVerification({
          state: 'pending',
          message: 'Server verification is still pending. Existing access remains unchanged; retry verification shortly.',
        });
      }
    } finally {
      clearTimeout(verificationTimeout);
      lifecycle.controller.signal.removeEventListener('abort', abortVerification);
      if (lifecycle.isCurrent() && verificationAttemptRef.current === attempt) {
        verificationRunningRef.current = false;
        setVerificationRunning(false);
      }
    }
  }

  async function purchasePlan(plan) {
    const lifecycle = lifecycleRef.current;
    if (!lifecycle || !lifecycle.isCurrent() || !statusRef.current || statusLoading
        || statusError || offersError || purchaseRunningRef.current
        || verificationRunningRef.current || pendingPlanRef.current) return;
    purchaseRunningRef.current = true;
    const operation = ++purchaseOperationRef.current;
    setPurchaseBusyPlan(plan.identifier);
    setPurchaseError('');
    setPurchaseMessage('');
    try {
      const result = await revenueCatCustomer.run(userId, async (purchases, sdk) => {
        const beforeUnloadHandler = event => {
          if (contextResetScheduledRef.current) return;
          event.preventDefault();
          event.returnValue = '';
        };
        beforeUnloadHandlerRef.current = beforeUnloadHandler;
        if (typeof window !== 'undefined') window.addEventListener('beforeunload', beforeUnloadHandler);
        checkoutPendingRef.current = true;
        try {
          const purchaseResult = await purchases.purchase({ rcPackage: plan.rcPackage });
          return { state: 'completed', portal: validManagementURL(purchaseResult.customerInfo?.managementURL) };
        } catch (error) {
          if (error?.errorCode === sdk.ErrorCode.UserCancelledError) return { state: 'cancelled' };
          if (error?.errorCode === sdk.ErrorCode.OperationAlreadyInProgressError) return { state: 'busy' };
          throw error;
        } finally {
          checkoutPendingRef.current = false;
          if (beforeUnloadHandlerRef.current === beforeUnloadHandler) {
            if (typeof window !== 'undefined') window.removeEventListener('beforeunload', beforeUnloadHandler);
            beforeUnloadHandlerRef.current = null;
          }
        }
      });
      if (!lifecycle.isCurrent()) return;
      if (result.state === 'cancelled') {
        setPurchaseMessage('Purchase cancelled. Server-verified access has not changed.');
        return;
      }
      if (result.state === 'busy') {
        setPurchaseError('A sandbox checkout is already open. Finish or close it before trying again.');
        return;
      }
      if (result.portal) setManagementURL(result.portal);
      purchaseRunningRef.current = false;
      setPurchaseBusyPlan('');
      await verifyWithServer(plan.identifier);
    } catch (error) {
      if (lifecycle.isCurrent() && error?.name !== 'AbortError') setPurchaseError(purchaseErrorMessage());
    } finally {
      purchaseRunningRef.current = false;
      if (purchaseOperationRef.current === operation) setPurchaseBusyPlan('');
    }
  }

  if (!SANDBOX_BILLING_ENABLED) {
    return <section className="billing-page" aria-labelledby="billing-title">
      <header className="page-header"><div className="page-header__copy"><h1 id="billing-title">Sandbox billing</h1></div></header>
      <div className="panel empty-state" role="status">
        <h2>Sandbox billing is unavailable</h2>
        <p>Configure both <code>VITE_REVENUECAT_ENVIRONMENT=sandbox</code> and <code>VITE_REVENUECAT_PUBLIC_KEY</code> to enable this test-only page. No purchases are available while configuration is missing.</p>
      </div>
    </section>;
  }

  if (lifecycleRef.current && lifecycleRef.current.userId !== userId) {
    return <section className="billing-page" aria-labelledby="billing-title">
      <header className="page-header"><div className="page-header__copy"><h1 id="billing-title">Sandbox billing</h1></div></header>
      <div className="panel empty-state" role="status">Loading billing for the signed-in account…</div>
    </section>;
  }
  const currentPlan = status ? serverPlanLabel(status.plan) : null;
  const expiresAt = status?.expires_at ? formatTimestamp(status.expires_at) : null;
  const verifiedAt = status?.verified_at ? formatTimestamp(status.verified_at) : null;
  const purchasesDisabled = statusLoading || !status || Boolean(statusError) || offersLoading
    || Boolean(offersError) || purchaseBusyPlan !== '' || purchaseRunningRef.current
    || contextResetScheduledRef.current || verificationRunning || pendingPlanRef.current !== null;

  return <section className="billing-page" aria-labelledby="billing-title">
    <header className="page-header">
      <div className="page-header__copy">
        <h1 id="billing-title">Sandbox billing</h1>
        <p>Review the RevenueCat sandbox packages for this signed-in account.</p>
      </div>
    </header>

    <aside className="billing-notice" role="note">Sandbox billing — test payments only; production access and quotas are unchanged.</aside>

    <section className="panel billing-snapshot" aria-labelledby="billing-snapshot-title" aria-busy={statusLoading}>
      <div className="billing-snapshot__heading">
        <h2 id="billing-snapshot-title">Server-verified access</h2>
        <span className="billing-environment">Sandbox</span>
      </div>
      {statusLoading && <p role="status">Loading server billing status…</p>}
      {status && <>
        <p className="billing-current-plan">{currentPlan}</p>
        <dl className="billing-metadata">
          <div><dt>Environment</dt><dd>{status.environment}</dd></div>
          {expiresAt && <div><dt>Expires</dt><dd>{expiresAt}</dd></div>}
          {verifiedAt && <div><dt>Last verified</dt><dd>{verifiedAt}</dd></div>}
        </dl>
      </>}
      {statusError && <p className="billing-error" role="alert">{statusError}</p>}
      {!statusLoading && !status && !statusError && <p role="status">No server billing status is available.</p>}
      <button type="button" className="button secondary billing-refresh" onClick={refreshStatus} disabled={statusLoading || verificationRunning}>
        {statusLoading ? 'Refreshing…' : 'Refresh status'}
      </button>
    </section>

    {verification && <div className={`billing-verification${verification.state === 'verified' ? ' is-verified' : ' is-pending'}`} role="status" aria-live="polite">
      <strong>{verification.state === 'verified' ? 'Server verification complete' : 'Verification pending'}</strong>
      <p>{verification.message}</p>
      {verification.state === 'pending' && <button type="button" className="button secondary" onClick={() => verifyWithServer(pendingPlanRef.current)} disabled={verificationRunning || !pendingPlanRef.current}>
        {verificationRunning ? 'Checking with the server…' : 'Retry verification'}
      </button>}
    </div>}

    <section className="billing-offers" aria-labelledby="billing-offers-title" aria-busy={offersLoading}>
      <div className="billing-section-heading">
        <div><h2 id="billing-offers-title">Sandbox packages</h2><p>Prices below come from the RevenueCat sandbox offering.</p></div>
        {managementURL && <a className="button secondary billing-portal" href={managementURL} target="_blank" rel="noopener noreferrer">Open sandbox customer portal</a>}
      </div>
      {offersLoading && <p role="status">Loading sandbox packages…</p>}
      {offersError && <div className="billing-error-block" role="alert">
        <p>{offersError}</p>
        <p>Confirm the sandbox <code>plans</code> offering contains the expected package and product identifiers.</p>
        <button type="button" className="button secondary" onClick={retryOffers}>Retry package loading</button>
      </div>}
      {!offersLoading && !offersError && offers.length > 0 && <div className="billing-plan-list">
        {offers.map(plan => <article className="panel billing-plan" key={plan.identifier}>
          <div className="billing-plan__summary">
            <h3>{plan.label}</h3>
            <p>Product ID: <code>{plan.productIdentifier}</code></p>
            <strong className="billing-plan__price">{plan.price} / month</strong>
          </div>
          <button type="button" className="button primary" onClick={() => purchasePlan(plan)} disabled={purchasesDisabled}>
            {purchaseBusyPlan === plan.identifier ? 'Opening checkout…' : verificationRunning ? 'Verifying…' : 'Continue to sandbox checkout'}
          </button>
        </article>)}
      </div>}
      {purchaseBusyPlan && <p className="billing-checkout-status" role="status" aria-live="polite">Sandbox checkout is active. Leaving while processing may still complete the payment; check server status before retrying.</p>}
      {purchaseMessage && <p className="billing-success" role="status">{purchaseMessage}</p>}
      {purchaseError && <p className="billing-error" role="alert">{purchaseError}</p>}
      {statusError && <p className="billing-supporting-error">Purchases are disabled until server billing status can be verified.</p>}
    </section>
  </section>;
}
