import { describe, expect, it } from "vitest";
import { externalInvoiceListRefreshOptions } from "../client/src/lib/invoiceListRefresh";

describe("external invoice list refresh", () => {
  it("refreshes email-created invoices every 30 seconds and immediately on browser focus", () => {
    expect(externalInvoiceListRefreshOptions).toEqual({
      refetchInterval: 30_000,
      refetchOnWindowFocus: "always",
    });
  });
});
