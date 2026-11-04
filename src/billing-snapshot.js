const PLAN_RANK = Object.freeze({ free: 0, pro: 1, ultra_pro: 2, max: 3 });

export function applyBillingSnapshot(snapshot, pendingPlan) {
  const verified = pendingPlan !== null
    && (PLAN_RANK[snapshot?.plan] ?? -1) >= (PLAN_RANK[pendingPlan] ?? Number.POSITIVE_INFINITY);

  return {
    status: snapshot,
    pendingPlan: verified ? null : pendingPlan,
    verified,
  };
}
