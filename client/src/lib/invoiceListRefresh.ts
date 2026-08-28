/**
 * Invoices created from Microsoft 365 arrive outside the browser session, so
 * the list must refresh independently of a manual browser reload.
 */
export const externalInvoiceListRefreshOptions = {
  refetchInterval: 30_000,
  refetchOnWindowFocus: "always" as const,
};
