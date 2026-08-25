import { describe, expect, it } from "vitest";
import { chooseStageOnePoContact, STAGE_ONE_FALLBACK_SUPPLIER } from "./vtigerPoService";

describe("Stage 1 supplier fallback", () => {
  it("uses the exact matched Xero contact when supplier resolution succeeds", () => {
    const result = chooseStageOnePoContact({
      status: "matched",
      matchBasis: "name_only",
      contact: { contactId: "pacific-contact", name: "Pacific National Services Pty Ltd", email: null, taxNumber: null },
      candidates: [],
      message: "matched",
    });

    expect(result).toEqual({ contactId: "pacific-contact", usedContainerzoneFallback: false });
  });

  it("uses CONTAINERZONE when an automated Stage 1 supplier is unmatched or ambiguous", () => {
    const result = chooseStageOnePoContact({
      status: "needs_selection",
      reason: "multiple_name_matches",
      candidates: [],
      nameMatchCount: 2,
      emailMatchCount: 0,
      message: "ambiguous",
    });

    expect(result).toEqual({
      contactId: STAGE_ONE_FALLBACK_SUPPLIER.contactId,
      usedContainerzoneFallback: true,
    });
  });

  it("does not create a new external supplier contact for a no-match Stage 1 cost", () => {
    const result = chooseStageOnePoContact({
      status: "create_new",
      candidates: [],
      message: "no match",
    });

    expect(result.contactId).toBe(STAGE_ONE_FALLBACK_SUPPLIER.contactId);
    expect(result.usedContainerzoneFallback).toBe(true);
  });
});
