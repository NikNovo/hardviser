const revenueCatEnvironment = import.meta.env?.VITE_REVENUECAT_ENVIRONMENT || '';
export const REVENUECAT_PUBLIC_KEY = import.meta.env?.VITE_REVENUECAT_PUBLIC_KEY?.trim() || '';
export const SANDBOX_BILLING_ENABLED = revenueCatEnvironment === 'sandbox' && Boolean(REVENUECAT_PUBLIC_KEY);
