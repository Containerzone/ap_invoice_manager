import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  retrieve: vi.fn(),
  preflight: vi.fn(),
  list: vi.fn(),
  last: vi.fn(),
  record: vi.fn(),
}));

vi.mock("./vtigerFinancialReadService", () => ({ retrieveCurrentVtigerFinancialRecord: mocks.retrieve }));
vi.mock("./financialReadOnlyXeroService", () => ({ preflightFinancialXeroIntents: mocks.preflight }));
vi.mock("./financialForHireDb", () => ({
  getForHireEventsForControl: mocks.list,
  lastVerifiedForHirePeriod: mocks.last,
  recordForHirePreview: mocks.record,
}));

import { previewInitialForHirePo, previewRecurringForHirePo } from "./financialForHireService";

const control = {
  id: "24x901", vtcmcontainercontrolsnumber: "C1860", cf_vtcmcontainercontrols_acquisition: "FOR HIRE",
  cf_vtcmcontainercontrols_status: "REQUEST", fld_vtcmcontainercontrolsname: "TGHU1234567",
  cf_vtcmcontainercontrols_containertype: "20 FOOT", cf_vtcmcontainercontrols_collectiondate: "01-10-2026",
  cf_vtcmcontainercontrols_suppliername: "18x44", cf_vtcmcontainercontrols_costpermonth: "132",
  modifiedtime: "2026-10-01T01:00:00.000Z",
};
const vendor = { id: "18x44", vendorname: "Hire Supplier" };
const clear = { duplicateState: "not_found", xeroDocumentId: null, status: null, partyName: null,
  contactCheck: { partyName: "Hire Supplier", found: true, count: 1, contactId: "contact-hire" },
  itemChecks: [{ itemCode: "HC 20", found: true, purchaseUnitPrice: 0, salesUnitPrice: 0, nativeDescription: "HC 20" }], error: null };

describe("For Hire AP-only previews", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.retrieve.mockImplementation(async (id: string) => id === "24x901" ? control : vendor);
    mocks.list.mockResolvedValue([]);
    mocks.last.mockResolvedValue(null);
    mocks.record.mockResolvedValue({ id: 1 });
  });

  it("re-reads the source and Vendor, binds the exact Xero contact, and stores an AP-only preview", async () => {
    mocks.preflight.mockResolvedValue([clear]);
    const result = await previewInitialForHirePo("24x901");
    expect(mocks.retrieve).toHaveBeenCalledWith("24x901");
    expect(mocks.retrieve).toHaveBeenCalledWith("18x44");
    expect(result).toMatchObject({ kind: "initial", state: "previewed", noWrites: true, preflight: expect.objectContaining({ duplicateState: "not_found" }) });
    expect(result.preview.document?.partySourceId).toBe("contact-hire");
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ status: "previewed", proposedPoNumber: "HC1860" }));
  });

  it("holds an existing Operations/Xero PO collision and does not allocate an alternative suffix", async () => {
    mocks.preflight.mockResolvedValue([{ ...clear, duplicateState: "found", xeroDocumentId: "legacy-po", status: "AUTHORISED" }]);
    const result = await previewInitialForHirePo("24x901");
    expect(result).toMatchObject({ state: "held", holdReason: expect.stringContaining("will not bypass") });
    expect(result.preview.proposedPoNumber).toBe("HC1860");
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ status: "held", proposedPoNumber: "HC1860" }));
  });

  it("does not read Xero or create a recurring proposal without a verified AP initial receipt", async () => {
    const recurringControl = { ...control, cf_vtcmcontainercontrols_status: "ON HIRE" };
    mocks.retrieve.mockImplementation(async (id: string) => id === "24x901" ? recurringControl : vendor);
    const result = await previewRecurringForHirePo("24x901");
    expect(result).toMatchObject({ kind: "recurring", state: "held", holdReason: expect.stringContaining("No verified AP") });
    expect(mocks.preflight).not.toHaveBeenCalled();
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ status: "held" }));
  });

  it("uses a current HC extension rate only after an AP receipt, while a repeated preview remains an AP-local idempotent record", async () => {
    const recurringControl = { ...control, cf_vtcmcontainercontrols_status: "IDLE" };
    mocks.retrieve.mockImplementation(async (id: string) => id === "24x901" ? recurringControl : vendor);
    mocks.last.mockResolvedValue({ periodEnd: "2026-09-30", suffix: null });
    mocks.preflight
      .mockResolvedValueOnce([{ ...clear, itemChecks: [{ itemCode: "HC 20 E", found: true, purchaseUnitPrice: 8, salesUnitPrice: 0, nativeDescription: "Native extension" }] }])
      .mockResolvedValueOnce([{ ...clear, itemChecks: [{ itemCode: "HC 20 E", found: true, purchaseUnitPrice: 8, salesUnitPrice: 0, nativeDescription: "Native extension" }] }])
      .mockResolvedValueOnce([{ ...clear, itemChecks: [{ itemCode: "HC 20 E", found: true, purchaseUnitPrice: 8, salesUnitPrice: 0, nativeDescription: "Native extension" }] }])
      .mockResolvedValueOnce([{ ...clear, itemChecks: [{ itemCode: "HC 20 E", found: true, purchaseUnitPrice: 8, salesUnitPrice: 0, nativeDescription: "Native extension" }] }]);
    const first = await previewRecurringForHirePo("24x901");
    const second = await previewRecurringForHirePo("24x901");
    expect(first.preview.document?.proposedDocumentNumber).toBe("HC1860-2");
    expect(first.preview.document?.lineItems[0]).toMatchObject({ itemCode: "HC 20 E", unitAmount: 8, quantity: 30 });
    expect(second.preview.proposedPoNumber).toBe(first.preview.proposedPoNumber);
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ eventKind: "recurring", billingPeriodStart: "2026-10-01", proposedPoNumber: "HC1860-2" }));
  });
});
