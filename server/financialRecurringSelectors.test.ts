import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ preflight: vi.fn() }));
vi.mock("./financialReadOnlyXeroService", () => ({ preflightFinancialXeroIntents: mocks.preflight }));

import {
  preflightRecurringForHireCandidate,
  selectRecurringForHireCandidate,
  selectRecurringStorageCandidate,
} from "./financialRecurringSelectors";

const now = new Date("2026-09-30T02:00:00.000Z");

function hireInput(overrides: Record<string, unknown> = {}) {
  return {
    sourceRecordId: "12x300", containerControlNumber: "CC1860", acquisition: "FOR HIRE", status: "ON HIRE",
    containerType: "40 foot", containerNumber: "CAXU1234567", collectionDate: "2026-08-01", supplierName: "Hire Supplier",
    lastVerifiedPeriodEnd: "2026-09-29", nextBillingDate: "2026-09-30", existingDocumentNumbers: ["HC1860-2"], now,
    ...overrides,
  };
}

describe("disabled recurring selector safety", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns one due FOR HIRE proposal only for ON HIRE or IDLE consecutive evidence", () => {
    const candidate = selectRecurringForHireCandidate(hireInput());
    expect(candidate).toMatchObject({ outcome: "candidate", noRecurringJdPo: true });
    expect(candidate.intents[0]).toMatchObject({ proposedDocumentNumber: "HC1860-3", accountCode: "312" });
  });

  it("excludes unsupported status and acquisition without attempting a catch-up", () => {
    expect(selectRecurringForHireCandidate(hireInput({ status: "REQUEST" }))).toMatchObject({ outcome: "no_current_candidate" });
    expect(selectRecurringForHireCandidate(hireInput({ acquisition: "ASSET" }))).toMatchObject({ outcome: "no_current_candidate" });
    expect(selectRecurringForHireCandidate(hireInput({ nextBillingDate: "2026-08-01" }))).toMatchObject({ outcome: "held" });
  });

  it("holds a gap rather than inventing a missing prior hire period", () => {
    expect(selectRecurringForHireCandidate(hireInput({ nextBillingDate: "2026-10-02" }))).toMatchObject({
      outcome: "held",
      reason: expect.stringContaining("not consecutive"),
    });
  });

  it("uses the current Xero purchase-side HC rate and holds collisions", async () => {
    const candidate = selectRecurringForHireCandidate(hireInput());
    mocks.preflight.mockResolvedValueOnce([{
      duplicateState: "not_found", itemChecks: [{ itemCode: "HC 40 E", purchaseUnitPrice: 12.5 }],
    }]);
    await expect(preflightRecurringForHireCandidate(candidate)).resolves.toMatchObject({
      outcome: "candidate",
      intents: [expect.objectContaining({ total: 412.5 })],
    });
    mocks.preflight.mockResolvedValueOnce([{
      duplicateState: "found", status: "AUTHORISED", itemChecks: [{ itemCode: "HC 40 E", purchaseUnitPrice: 12.5 }],
    }]);
    await expect(preflightRecurringForHireCandidate(candidate)).resolves.toMatchObject({ outcome: "held" });
  });

  it("sources recurring storage only from a verified open AP event and never creates JD", () => {
    const candidate = selectRecurringStorageCandidate({
      storageBillingEventId: 1, activationVerified: true, finalisationStatus: "open", billedThroughDate: "2026-09-29", nextBillingDate: "2026-09-30",
      dealNumber: "D702900", containerNumber: "CAXU1234567", containerType: "20 foot", customerName: "Customer", storageSupplierName: "Storage Supplier", now,
    });
    expect(candidate).toMatchObject({ outcome: "candidate", noRecurringJdPo: true });
    expect(candidate.intents.map((intent) => intent.proposedDocumentNumber)).toEqual(["INV-702900-S", "GD702900"]);
    expect(candidate.intents.some((intent) => intent.proposedDocumentNumber?.startsWith("JD"))).toBe(false);
    expect(candidate.intents[1]).toMatchObject({ accountCode: "311" });
    expect(selectRecurringStorageCandidate({
      storageBillingEventId: 2, activationVerified: false, finalisationStatus: "open", now,
    })).toMatchObject({ outcome: "no_current_candidate" });
  });
});
