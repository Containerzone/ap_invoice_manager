import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  retrieve: vi.fn(),
  preflight: vi.fn(),
  list: vi.fn(),
  last: vi.fn(),
  record: vi.fn(),
  schedules: vi.fn(),
  releasePolicy: vi.fn(),
}));

vi.mock("./vtigerFinancialReadService", () => ({ retrieveCurrentVtigerFinancialRecord: mocks.retrieve }));
vi.mock("./financialReadOnlyXeroService", () => ({ preflightFinancialXeroIntents: mocks.preflight }));
vi.mock("./financialForHireDb", () => ({
  getForHireEventsForControl: mocks.list,
  lastVerifiedForHirePeriod: mocks.last,
  recordForHirePreview: mocks.record,
}));
// These readiness dependencies must not load real database or release-policy I/O.
vi.mock("./financialWorkflowDb", () => ({ getFinancialWorkflowSchedules: mocks.schedules }));
vi.mock("./financialForHireRelease", () => ({ getForHireReleasePolicy: mocks.releasePolicy }));

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

// Offline HC1929 scenario: container number and current purchase rate are test data,
// not values retrieved from a live Container Control or Xero item.
const hc1929 = {
  ...control,
  id: "24x1929",
  vtcmcontainercontrolsnumber: "C1929",
  cf_vtcmcontainercontrols_status: "ON HIRE",
  cf_vtcmcontainercontrols_containertype: "40 Foot Standard",
  cf_vtcmcontainercontrols_collectiondate: "13-11-2026",
  modifiedtime: "2026-12-14T00:00:00.000Z",
};

function useControl(source: typeof control) {
  mocks.retrieve.mockImplementation(async (id: string) => {
    if (id === source.id) return source;
    if (id === vendor.id) return vendor;
    throw new Error(`Unexpected offline VTiger read: ${id}`);
  });
}

function useExtensionRate(itemCode: string, purchaseUnitPrice: number) {
  mocks.preflight.mockResolvedValue([{ ...clear, itemChecks: [{
    itemCode, found: true, purchaseUnitPrice, salesUnitPrice: 999,
    nativeDescription: "Native Xero description must not replace the container-specific period",
  }] }]);
}

function freezeBusinessDay(day: string) {
  // 02:00 UTC is within the same Sydney calendar day in both standard and DST time.
  vi.setSystemTime(new Date(`${day}T02:00:00.000Z`));
}

describe("For Hire AP-only previews", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    freezeBusinessDay("2026-10-01");
    useControl(control);
    mocks.list.mockResolvedValue([]);
    mocks.last.mockResolvedValue(null);
    mocks.record.mockResolvedValue({ id: 1 });
  });

  afterEach(() => {
    vi.useRealTimers();
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
    useControl({ ...control, cf_vtcmcontainercontrols_status: "ON HIRE" });
    const result = await previewRecurringForHirePo("24x901", "2026-10-01");
    expect(result).toMatchObject({ kind: "recurring", state: "held", holdReason: expect.stringContaining("No verified AP"), noWrites: true });
    expect(mocks.preflight).not.toHaveBeenCalled();
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ status: "held", proposal: null }));
  });

  it("uses a current HC extension rate only after an AP receipt and records the same period on repeated previews", async () => {
    useControl({ ...control, cf_vtcmcontainercontrols_status: "IDLE" });
    mocks.last.mockResolvedValue({ periodEnd: "2026-09-30", suffix: null });
    useExtensionRate("HC 20 E", 8);
    const first = await previewRecurringForHirePo("24x901", "2026-10-01");
    const second = await previewRecurringForHirePo("24x901", "2026-10-01");
    expect(first).toMatchObject({ state: "previewed", noWrites: true });
    expect(first.preview.document?.proposedDocumentNumber).toBe("HC1860-2");
    expect(first.preview.document?.lineItems[0]).toMatchObject({ itemCode: "HC 20 E", unitAmount: 8, quantity: 30 });
    expect(second.preview.proposedPoNumber).toBe(first.preview.proposedPoNumber);
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ eventKind: "recurring", billingPeriodStart: "2026-10-01", proposedPoNumber: "HC1860-2" }));
  });

  it("uses the explicit preview date for the rate-only lookup even when the wall clock is later", async () => {
    freezeBusinessDay("2026-12-14");
    useControl({ ...control, cf_vtcmcontainercontrols_status: "IDLE" });
    mocks.last.mockResolvedValue({ periodEnd: "2026-09-30", suffix: null });
    useExtensionRate("HC 20 E", 8);

    const result = await previewRecurringForHirePo(control.id, "2026-10-01");

    expect(result).toMatchObject({ state: "previewed", noWrites: true });
    expect(result.preview).toMatchObject({ proposedPoNumber: "HC1860-2", periodStart: "2026-10-01", periodEnd: "2026-10-30" });
    expect(mocks.preflight).toHaveBeenCalledTimes(2);
    expect(result.preview.document?.lineItems[0]).toMatchObject({ itemCode: "HC 20 E", unitAmount: 8 });
  });

  it("does not read Xero when the explicit next-period date is not due, even if the wall clock is due", async () => {
    freezeBusinessDay("2026-12-14");
    useControl({ ...hc1929, cf_vtcmcontainercontrols_containertype: "40 FOOT" });
    mocks.last.mockResolvedValue({ periodEnd: "2026-12-13", suffix: null });
    useExtensionRate("HC 40 E", 16.5);

    const result = await previewRecurringForHirePo(hc1929.id, "2026-12-13");

    expect(result).toMatchObject({ state: "held", noWrites: true, holdReason: expect.stringContaining("not due") });
    expect(result.preview.document).toBeNull();
    expect(mocks.preflight).not.toHaveBeenCalled();
  });

  it("previews HC1929-2 only when its 40 Foot Standard next period is due on 14 December, using the current HC 40 E purchase rate", async () => {
    freezeBusinessDay("2026-12-14");
    useControl(hc1929);
    mocks.last.mockResolvedValue({ periodEnd: "2026-12-13", suffix: null });
    useExtensionRate("HC 40 E", 16.5);

    const result = await previewRecurringForHirePo(hc1929.id, "2026-12-14");

    expect(result).toMatchObject({ state: "previewed", holdReason: null, noWrites: true });
    expect(result.preview).toMatchObject({ proposedPoNumber: "HC1929-2", periodStart: "2026-12-14", periodEnd: "2027-01-12" });
    expect(result.preview.document).toMatchObject({
      documentFamily: "purchase_order", documentType: "recurring_for_hire",
      proposedDocumentNumber: "HC1929-2", partySourceId: "contact-hire",
      issueDate: new Date("2026-12-14T00:00:00.000Z"),
    });
    expect(result.preview.document?.lineItems).toEqual([expect.objectContaining({
      itemCode: "HC 40 E", quantity: 30, unitAmount: 16.5, accountCode: "312",
      description: "TGHU1234567, 40 Foot Standard Extended Hire @ $16.50 per day from 14/12/26 to 12/01/27",
    })]);
    expect(mocks.preflight).toHaveBeenCalledTimes(2);
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({
      containerControlId: hc1929.id, status: "previewed", proposedPoNumber: "HC1929-2",
      billingPeriodStart: "2026-12-14", billingPeriodEnd: "2027-01-12",
    }));
  });

  it("holds HC1929 before its own due date without even looking up an extension rate", async () => {
    freezeBusinessDay("2026-12-13");
    useControl(hc1929);
    mocks.last.mockResolvedValue({ periodEnd: "2026-12-13", suffix: null });

    const result = await previewRecurringForHirePo(hc1929.id, "2026-12-13");

    expect(result).toMatchObject({ state: "held", noWrites: true, holdReason: expect.stringContaining("not due") });
    expect(result.preview).toMatchObject({ periodStart: "2026-12-14", periodEnd: "2027-01-12", proposedPoNumber: null, document: null });
    expect(mocks.preflight).not.toHaveBeenCalled();
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ status: "held", proposal: null }));
  });

  it("does not turn the next day's check into a daily PO or advance an unverified source period", async () => {
    freezeBusinessDay("2026-12-14");
    const source = { ...hc1929 };
    const sourceBefore = { ...source };
    const prior = { periodEnd: "2026-12-13", suffix: null };
    useControl(source);
    mocks.last.mockResolvedValue(prior);
    useExtensionRate("HC 40 E", 16.5);

    const first = await previewRecurringForHirePo(source.id, "2026-12-14");
    freezeBusinessDay("2026-12-15");
    const nextDay = await previewRecurringForHirePo(source.id, "2026-12-15");

    expect(first).toMatchObject({ state: "previewed", noWrites: true });
    expect(nextDay).toMatchObject({ state: "previewed", noWrites: true });
    for (const result of [first, nextDay]) {
      expect(result.preview).toMatchObject({ proposedPoNumber: "HC1929-2", periodStart: "2026-12-14", periodEnd: "2027-01-12" });
      expect(result.preview.document?.issueDate).toEqual(new Date("2026-12-14T00:00:00.000Z"));
    }
    expect(mocks.last).toHaveBeenCalledTimes(2);
    expect(prior).toEqual({ periodEnd: "2026-12-13", suffix: null });
    expect(source).toEqual(sourceBefore);
    expect(mocks.record).toHaveBeenCalledTimes(2);
    for (const [record] of mocks.record.mock.calls) {
      expect(record).toMatchObject({ status: "previewed", proposedPoNumber: "HC1929-2", billingPeriodStart: "2026-12-14", billingPeriodEnd: "2027-01-12" });
    }
  });

  it("advances HC1929 to suffix 3 only from a verified suffix-2 receipt and only when due on 13 January", async () => {
    useControl(hc1929);
    mocks.last.mockResolvedValue({ periodEnd: "2027-01-12", suffix: 2 });
    useExtensionRate("HC 40 E", 17.25);
    freezeBusinessDay("2027-01-12");

    const beforeDue = await previewRecurringForHirePo(hc1929.id, "2027-01-12");
    expect(beforeDue).toMatchObject({ state: "held", holdReason: expect.stringContaining("not due"), noWrites: true });
    expect(beforeDue.preview.document).toBeNull();
    expect(mocks.preflight).not.toHaveBeenCalled();

    freezeBusinessDay("2027-01-13");
    const due = await previewRecurringForHirePo(hc1929.id, "2027-01-13");
    expect(due).toMatchObject({ state: "previewed", noWrites: true });
    expect(due.preview).toMatchObject({ proposedPoNumber: "HC1929-3", periodStart: "2027-01-13", periodEnd: "2027-02-11" });
    expect(due.preview.document?.lineItems[0]).toMatchObject({ itemCode: "HC 40 E", quantity: 30, unitAmount: 17.25 });
  });

  it("uses HC 20 E, not HC 40 E or a sales rate, for a due 20-foot extension", async () => {
    freezeBusinessDay("2026-12-14");
    useControl({ ...hc1929, cf_vtcmcontainercontrols_containertype: "20 FOOT" });
    mocks.last.mockResolvedValue({ periodEnd: "2026-12-13", suffix: null });
    useExtensionRate("HC 20 E", 8.25);

    const result = await previewRecurringForHirePo(hc1929.id, "2026-12-14");
    expect(result).toMatchObject({ state: "previewed", noWrites: true });
    expect(result.preview.document?.lineItems).toEqual([expect.objectContaining({
      itemCode: "HC 20 E", quantity: 30, unitAmount: 8.25,
      description: "TGHU1234567, 20 FOOT Extended Hire @ $8.25 per day from 14/12/26 to 12/01/27",
    })]);
  });

  it.each([
    { status: "DEHIRED", acquisition: "FOR HIRE", state: "dehired", reason: "DEHIRED" },
    { status: "REQUEST", acquisition: "FOR HIRE", state: "held", reason: "ON HIRE or IDLE" },
    { status: "ON HIRE", acquisition: "ASSET", state: "held", reason: "not FOR HIRE" },
  ])("holds $acquisition / $status without Xero reads or a financial write proposal", async ({ status, acquisition, state, reason }) => {
    freezeBusinessDay("2026-12-14");
    // A supported spaced type isolates the status/acquisition guard from type parsing.
    useControl({ ...hc1929, cf_vtcmcontainercontrols_containertype: "40 FOOT", cf_vtcmcontainercontrols_status: status, cf_vtcmcontainercontrols_acquisition: acquisition });
    mocks.last.mockResolvedValue({ periodEnd: "2026-12-13", suffix: null });

    const result = await previewRecurringForHirePo(hc1929.id, "2026-12-14");
    expect(result).toMatchObject({ state, holdReason: expect.stringContaining(reason), noWrites: true });
    expect(result.preview.document).toBeNull();
    expect(result.preview.proposedPoNumber).toBeNull();
    expect(mocks.preflight).not.toHaveBeenCalled();
    // Only a mocked AP-local hold/dehire audit is allowed; it has no financial proposal.
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ status: state, proposal: null }));
  });

  it("does not infer HC1929's predecessor from source dates or an unverified preview", async () => {
    freezeBusinessDay("2026-12-14");
    useControl({ ...hc1929, cf_vtcmcontainercontrols_containertype: "40 FOOT" });
    mocks.list.mockResolvedValue([{ status: "previewed", proposedPoNumber: "HC1929", billingPeriodEnd: "2026-12-13" }]);
    mocks.last.mockResolvedValue(null);

    const result = await previewRecurringForHirePo(hc1929.id, "2026-12-14");
    expect(result).toMatchObject({ state: "held", holdReason: expect.stringContaining("No verified AP"), noWrites: true });
    expect(result.preview.document).toBeNull();
    expect(mocks.preflight).not.toHaveBeenCalled();
  });

  it("retains the old expired-period hold instead of catching up or substituting today's date", async () => {
    freezeBusinessDay("2026-12-14");
    useControl({ ...hc1929, cf_vtcmcontainercontrols_containertype: "40 FOOT" });
    mocks.last.mockResolvedValue({ periodEnd: "2026-09-30", suffix: null });

    const result = await previewRecurringForHirePo(hc1929.id, "2026-12-14");
    expect(result).toMatchObject({ state: "held", holdReason: expect.stringContaining("historical"), noWrites: true });
    expect(result.preview).toMatchObject({ periodStart: "2026-10-01", periodEnd: "2026-10-30", document: null, proposedPoNumber: null });
    expect(mocks.preflight).not.toHaveBeenCalled();
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ status: "held", proposal: null }));
  });
});
