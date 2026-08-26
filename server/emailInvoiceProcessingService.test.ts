import { describe, expect, it } from "vitest";
import { selectInboundInvoiceOwner } from "./emailInvoiceProcessingService";

describe("inbound email invoice attribution", () => {
  it("uses the configured owner when present", () => {
    expect(selectInboundInvoiceOwner({ id: 10 }, { id: 20 })).toEqual({ id: 10 });
  });

  it("uses an active administrator when the configured owner is unavailable", () => {
    expect(selectInboundInvoiceOwner(undefined, { id: 20 })).toEqual({ id: 20 });
  });

  it("does not attribute inbound invoices when no safe owner exists", () => {
    expect(selectInboundInvoiceOwner(undefined, undefined)).toBeUndefined();
  });
});
