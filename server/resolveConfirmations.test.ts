import { describe, expect, it } from "vitest";
import { getResolveConfirmationBlockers } from "../client/src/lib/resolveConfirmations";

describe("Resolve & Push confirmation guard", () => {
  it("requires only the invoice-number acknowledgement when the supplier contact is already confirmed", () => {
    const beforeAcknowledgement = getResolveConfirmationBlockers({
      hasXeroConflict: true,
      xeroConflictAcknowledged: false,
      supplierContactNeedsSelection: false,
      selectedXeroContactId: "",
      contactSelectionApproved: false,
    });
    const afterAcknowledgement = getResolveConfirmationBlockers({
      hasXeroConflict: true,
      xeroConflictAcknowledged: true,
      supplierContactNeedsSelection: false,
      selectedXeroContactId: "",
      contactSelectionApproved: false,
    });

    expect(beforeAcknowledgement).toEqual(["acknowledge the invoice-number conflict"]);
    expect(afterAcknowledgement).toEqual([]);
  });

  it("keeps only the invoice-number safeguard when an ambiguous supplier contact has already been selected and approved", () => {
    const blockers = getResolveConfirmationBlockers({
      hasXeroConflict: true,
      xeroConflictAcknowledged: false,
      supplierContactNeedsSelection: true,
      selectedXeroContactId: "qco-contact",
      contactSelectionApproved: true,
    });

    expect(blockers).toEqual(["acknowledge the invoice-number conflict"]);
  });
});
