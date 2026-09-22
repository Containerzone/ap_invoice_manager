import { describe, expect, it, vi } from "vitest";
import { recoverExistingBillAfterTransientCreateFailure } from "./xeroService";

describe("uncertain Xero bill creation recovery", () => {
  const recoveredBill = { InvoiceID: "bill-123", InvoiceNumber: "INV-123" };

  it("performs one read-only recovery lookup after a gateway timeout", async () => {
    const findExisting = vi.fn().mockResolvedValue(recoveredBill);

    await expect(recoverExistingBillAfterTransientCreateFailure(
      { response: { status: 504 } },
      findExisting,
    )).resolves.toEqual(recoveredBill);
    expect(findExisting).toHaveBeenCalledTimes(1);
  });

  it("does not look up or retry after a non-gateway create failure", async () => {
    const findExisting = vi.fn();

    await expect(recoverExistingBillAfterTransientCreateFailure(
      { response: { status: 400 } },
      findExisting,
    )).resolves.toBeNull();
    expect(findExisting).not.toHaveBeenCalled();
  });

  it("keeps the original create failure actionable when the recovery lookup is unavailable", async () => {
    const findExisting = vi.fn().mockRejectedValue(new Error("temporary read failure"));

    await expect(recoverExistingBillAfterTransientCreateFailure(
      { response: { status: 504 } },
      findExisting,
    )).resolves.toBeNull();
    expect(findExisting).toHaveBeenCalledTimes(1);
  });
});
