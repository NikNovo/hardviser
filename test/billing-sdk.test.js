import assert from 'node:assert/strict';
import test from 'node:test';
import { createRevenueCatCustomerCoordinator } from '../src/billing-sdk.js';

const ACCOUNT_A_ID = '123e4567-e89b-42d3-a456-426614174006';
const ACCOUNT_B_ID = '123e4567-e89b-42d3-a456-426614174007';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('a customer switch waits for a purchase and discards the old account result', async () => {
  const purchaseGate = deferred();
  const purchaseStarted = deferred();
  const calls = [];
  let currentUser = null;
  let configureCount = 0;
  const sdk = {
    isSandbox: () => {
      calls.push('is-sandbox');
      return true;
    },
    changeUser: async userId => {
      calls.push(`change:${userId}`);
      currentUser = userId;
    },
    getOfferings: async () => ({ userId: currentUser }),
  };
  const coordinator = createRevenueCatCustomerCoordinator({
    apiKey: 'sandbox-public-key',
    loadPurchases: async () => ({
      Purchases: {
        configure: ({ appUserId }) => {
          configureCount += 1;
          calls.push(`configure:${appUserId}`);
          currentUser = appUserId;
          return sdk;
        },
      },
    }),
  });

  const leaveAccountA = coordinator.activate(ACCOUNT_A_ID);
  const purchaseA = coordinator.run(ACCOUNT_A_ID, async purchases => {
    calls.push(`purchase:start:${currentUser}`);
    purchaseStarted.resolve();
    await purchaseGate.promise;
    calls.push(`purchase:end:${currentUser}`);
    return 'account-a-purchase';
  });
  await purchaseStarted.promise;

  coordinator.activate(ACCOUNT_B_ID);
  leaveAccountA();
  const offeringsB = coordinator.run(ACCOUNT_B_ID, purchases => {
    calls.push(`offerings:${currentUser}`);
    return purchases.getOfferings();
  });
  purchaseGate.resolve();

  await assert.rejects(purchaseA, error => error.name === 'AbortError');
  assert.deepEqual(await offeringsB, { userId: ACCOUNT_B_ID });
  assert.equal(configureCount, 1);
  assert.deepEqual(calls, [
    `configure:${ACCOUNT_A_ID}`,
    'is-sandbox',
    `purchase:start:${ACCOUNT_A_ID}`,
    `purchase:end:${ACCOUNT_A_ID}`,
    `change:${ACCOUNT_B_ID}`,
    `offerings:${ACCOUNT_B_ID}`,
  ]);
});

test('sign-out prevents queued SDK work from configuring a stale customer', async () => {
  const sdkLoad = deferred();
  const sdkLoadStarted = deferred();
  let configureCount = 0;
  const coordinator = createRevenueCatCustomerCoordinator({
    apiKey: 'sandbox-public-key',
    loadPurchases: () => {
      sdkLoadStarted.resolve();
      return sdkLoad.promise;
    },
  });
  const leaveAccountA = coordinator.activate(ACCOUNT_A_ID);
  const staleOperation = coordinator.run(ACCOUNT_A_ID, () => assert.fail('stale SDK work must not run'));
  await sdkLoadStarted.promise;
  leaveAccountA();
  sdkLoad.resolve({
    Purchases: {
      configure: () => { configureCount += 1; },
    },
  });

  await assert.rejects(staleOperation, error => error.name === 'AbortError');
  assert.equal(configureCount, 0);
});

test('live and unknown SDK environments never run billing operations', async () => {
  for (const mode of [false, undefined]) {
    let configureCount = 0;
    let changeUserCount = 0;
    let modeCheckCount = 0;
    let operationCount = 0;
    const sdk = {
      isSandbox: () => {
        modeCheckCount += 1;
        return mode;
      },
      changeUser: async () => { changeUserCount += 1; },
    };
    const coordinator = createRevenueCatCustomerCoordinator({
      apiKey: 'sandbox-public-key',
      loadPurchases: async () => ({
        Purchases: {
          configure: () => {
            configureCount += 1;
            return sdk;
          },
        },
      }),
    });
    const leaveAccountA = coordinator.activate(ACCOUNT_A_ID);

    await assert.rejects(
      coordinator.run(ACCOUNT_A_ID, () => { operationCount += 1; }),
      /sandbox/i,
    );
    leaveAccountA();
    coordinator.activate(ACCOUNT_B_ID);
    await assert.rejects(
      coordinator.run(ACCOUNT_B_ID, () => { operationCount += 1; }),
      /sandbox/i,
    );

    assert.equal(configureCount, 1);
    assert.equal(modeCheckCount, 1);
    assert.equal(changeUserCount, 0);
    assert.equal(operationCount, 0);
  }
});

test('navigation disposal closes the SDK and blocks reuse of the old context', async () => {
  let closeCount = 0;
  let operationCount = 0;
  const sdk = {
    isSandbox: () => true,
    close: () => { closeCount += 1; },
    getOfferings: async () => {
      operationCount += 1;
      return [];
    },
  };
  const coordinator = createRevenueCatCustomerCoordinator({
    apiKey: 'sandbox-public-key',
    loadPurchases: async () => ({
      Purchases: { configure: () => sdk },
    }),
  });

  const leaveAccountA = coordinator.activate(ACCOUNT_A_ID);
  await coordinator.run(ACCOUNT_A_ID, purchases => purchases.getOfferings());
  coordinator.disposeForNavigation();
  leaveAccountA();
  coordinator.activate(ACCOUNT_B_ID);

  await assert.rejects(
    coordinator.run(ACCOUNT_B_ID, () => { operationCount += 1; }),
    /context is being reset/i,
  );
  assert.equal(closeCount, 1);
  assert.equal(operationCount, 1);
});
