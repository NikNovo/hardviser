import { REVENUECAT_PUBLIC_KEY } from './billing-config.js';

function accountChangedError() {
  const error = new Error('The signed-in account changed during this billing operation.');
  error.name = 'AbortError';
  return error;
}

export function createRevenueCatCustomerCoordinator({ apiKey, loadPurchases }) {
  let activeUserId = null;
  let generation = 0;
  let queue = Promise.resolve();
  let purchasesModulePromise = null;
  let purchases = null;
  let appUserId = null;
  let sandboxModeVerified = false;
  let disposedForNavigation = false;

  function isCurrent(userId, requestGeneration) {
    return activeUserId === userId && generation === requestGeneration;
  }

  function activate(userId) {
    if (typeof userId !== 'string' || !userId.trim()) {
      throw new Error('Sandbox billing requires a verified signed-in account.');
    }
    activeUserId = userId;
    const activation = ++generation;
    return () => {
      if (generation === activation && activeUserId === userId) {
        activeUserId = null;
        generation += 1;
      }
    };
  }

  function loadSdk() {
    if (!purchasesModulePromise) {
      purchasesModulePromise = Promise.resolve().then(loadPurchases).catch(error => {
        purchasesModulePromise = null;
        throw error;
      });
    }
    return purchasesModulePromise;
  }

  function run(userId, operation) {
    if (disposedForNavigation) {
      return Promise.reject(new Error('The RevenueCat billing context is being reset; reload before continuing.'));
    }
    if (typeof userId !== 'string' || !userId.trim()) {
      return Promise.reject(new Error('Sandbox billing requires a verified signed-in account.'));
    }
    if (typeof operation !== 'function') {
      return Promise.reject(new TypeError('A RevenueCat operation is required.'));
    }
    const requestGeneration = generation;
    const pending = queue.then(async () => {
      if (!isCurrent(userId, requestGeneration)) throw accountChangedError();
      if (!apiKey) throw new Error('Sandbox billing is not configured with a public API key.');
      const module = await loadSdk();
      if (!isCurrent(userId, requestGeneration)) throw accountChangedError();
      if (!purchases) {
        purchases = module.Purchases.configure({ apiKey, appUserId: userId });
        appUserId = userId;
        try {
          sandboxModeVerified = typeof purchases?.isSandbox === 'function'
            && purchases.isSandbox() === true;
        } catch {
          sandboxModeVerified = false;
        }
      }
      if (!sandboxModeVerified) {
        throw new Error('RevenueCat did not confirm sandbox mode; billing operations are blocked.');
      }
      if (appUserId !== userId) {
        await purchases.changeUser(userId);
        appUserId = userId;
      }
      if (!isCurrent(userId, requestGeneration)) throw accountChangedError();
      const result = await operation(purchases, module);
      if (!isCurrent(userId, requestGeneration)) throw accountChangedError();
      return result;
    });
    queue = pending.catch(() => undefined);
    return pending;
  }
  function disposeForNavigation() {
    disposedForNavigation = true;
    const instance = purchases;
    purchases = null;
    appUserId = null;
    sandboxModeVerified = false;
    if (typeof instance?.close === 'function') instance.close();
  }

  return { activate, run, disposeForNavigation };
}


export const revenueCatCustomer = createRevenueCatCustomerCoordinator({
  apiKey: REVENUECAT_PUBLIC_KEY,
  loadPurchases: () => import('@revenuecat/purchases-js'),
});
