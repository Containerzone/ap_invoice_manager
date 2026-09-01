import { describe, expect, it } from "vitest";
import {
  chooseStageOnePoContact,
  getMappedTransportCostFields,
  processVtigerWebhook,
  STAGE_ONE_FALLBACK_SUPPLIER,
} from "./vtigerPoService";

describe("Vtiger webhook payload validation", () => {
  it("identifies configured Stage 1 transport-cost fields despite inconsistent label spacing", () => {
    expect(getMappedTransportCostFields({
      "deal id ": "D702837",
      " cf_quotes_emptydelivery ": "125.00",
      "unrelated field": "ignored",
    })).toEqual([" cf_quotes_emptydelivery "]);
  });

  it("rejects an ID-only event before attempting Xero work", async () => {
    await expect(processVtigerWebhook({ "deal id ": "D702837" }))
      .rejects.toThrow("No mapped transport cost fields were received for deal D702837");
  });
});

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
