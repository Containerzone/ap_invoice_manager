import { describe, expect, it } from "vitest";
import {
  buildExtraHireInvoice,
  deriveExtraHireInvoiceNumber,
  extendExtraHireDate,
  extraHireDate,
  type ExtraHireFacts,
  type ExtraHireClaim,
} from "./financialExtraHireInvoiceRules";
const facts: ExtraHireFacts = {
  dealId: "5x77",
  dealNumber: "D77",
  containerNumber: "ABCU1234567",
  containerType: "20 Foot Standard",
  containerFeet: 20,
  hireDuration: 30,
  hireEndDate: "2026-01-31",
  customerVtigerId: "3x88",
  customerName: "Synthetic Customer",
  customerKind: "organisation",
  sourceRefreshedAt: "2026-01-01T00:00:00Z",
  customerRefreshedAt: null,
  mappingEvidence: {},
  sourceHoldReason: null,
};
const dates = "CURRENT_HIRE_END_DATE_NO_DUE_DATE";
const item = {
  itemCode: "20' Hire" as const,
  unitAmount: 45,
  accountCode: "210",
  taxType: "OUTPUT" as const,
};
const build = (f = facts, code = item, date = dates) =>
  buildExtraHireInvoice(f, "INV-77-EH1", code, date);
describe("Extra Hire exact Draft arithmetic and line contract", () => {
  it("formats 20ft GST-exclusive 4.286 weeks with exact source issue date", () => {
    const doc = build().document!;
    expect(doc).toMatchObject({
      documentFamily: "customer_invoice",
      documentType: "extra_hire",
      sourceWorkflow: "extra_hire",
      proposedAction: "create_draft",
      proposedDocumentNumber: "INV-77-EH1",
      currency: "AUD",
      gstTreatment: "GST_EXCLUSIVE",
      subtotal: 192.87,
      taxAmount: 19.29,
      total: 212.16,
      dueDate: null,
    });
    expect(doc.issueDate?.toISOString()).toBe("2026-01-31T00:00:00.000Z");
    expect(doc.lineItems).toEqual([
      {
        itemCode: "20' Hire",
        description: "20' Extra Hire — ABCU1234567",
        quantity: 4.286,
        unitAmount: 45,
        lineAmount: 192.87,
        accountCode: "210",
        taxRate: 10,
        gstTreatment: "GST_EXCLUSIVE",
      },
    ]);
  });
  it("uses exact 40ft current item rate/account evidence, not a guessed constant", () => {
    const doc = buildExtraHireInvoice(
      { ...facts, containerFeet: 40 },
      "INV-77-EH1",
      { ...item, itemCode: "40' Hire", unitAmount: 70 },
      dates
    ).document!;
    expect(doc).toMatchObject({
      subtotal: 300.02,
      taxAmount: 30,
      total: 330.02,
    });
    expect(
      buildExtraHireInvoice(
        facts,
        "INV-77-EH1",
        { ...item, unitAmount: 50, accountCode: "211" },
        dates
      ).document
    ).toMatchObject({ subtotal: 214.3, accountCode: "211", total: 235.73 });
  });
  it.each(["", "today", "CURRENT_HIRE_END_DATE"])(
    "holds unknown date semantics %s",
    date =>
      expect(build(facts, item, date).holdReason).toMatch(/business semantics/)
  );
  it.each([
    { hireDuration: 60 },
    { hireEndDate: null },
    { containerFeet: null },
    { customerVtigerId: "" },
    { containerNumber: "" },
    { sourceRefreshedAt: null },
    { sourceHoldReason: "Mapping ambiguous" },
  ])("holds incomplete source %j", change =>
    expect(build({ ...facts, ...change } as ExtraHireFacts).eligible).toBe(
      false
    )
  );
  it.each(["INV-77-D", "INV-77", "INV-77-EH0", "INV-78-EH1"])(
    "never uses another series %s",
    number =>
      expect(buildExtraHireInvoice(facts, number, item, dates).eligible).toBe(
        false
      )
  );
  it.each(["2026-02-30", "31-01-2026", "2026-01-31T00:00:00Z", ""])(
    "does not guess ISO date %s",
    v => expect(extraHireDate(v)).toBeNull()
  );
  it("adds calendar days across month/leap/year boundaries", () => {
    expect(extendExtraHireDate("2026-01-31")).toBe("2026-03-02");
    expect(extendExtraHireDate("2028-01-31")).toBe("2028-03-01");
    expect(extendExtraHireDate("2026-12-15")).toBe("2027-01-14");
  });
});
describe("Extra Hire exact AP-only ordinal and all-status Xero collision history", () => {
  const resolve = (
    history: any[] = [],
    claims: ExtraHireClaim[] = [],
    confirmed = true,
    date = "2026-01-31"
  ) => deriveExtraHireInvoiceNumber("D77", date, history, claims, confirmed);
  const claim: ExtraHireClaim = {
    ordinal: 1,
    claimedInvoiceNumber: "INV-77-EH1",
    sourceHireEndDate: "2026-01-01",
    status: "drafts_created",
    xeroInvoiceId: "xero-1",
  };
  const row = {
    InvoiceNumber: "INV-77-EH1",
    InvoiceID: "xero-1",
    Status: "DRAFT",
    Type: "ACCREC",
  };
  it("new dedicated series never uses Deposit -D even when present", () =>
    expect(resolve([{ ...row, InvoiceNumber: "INV-77-D" }])).toEqual({
      ordinal: 1,
      invoiceNumber: "INV-77-EH1",
      holdReason: null,
    }));
  it("holds unproved legacy suffix semantics", () =>
    expect(resolve([], [], false).holdReason).toMatch(/Legacy suffix/));
  it.each(["DRAFT", "AUTHORISED", "PAID", "DELETED", "VOIDED"])(
    "never adopts or skips an unowned %s collision",
    Status =>
      expect(resolve([{ ...row, Status }]).holdReason).toMatch(
        /unowned|deleted|ambiguous/
      )
  );
  it("next exact ordinal requires contiguous successful AP claims and unchanged Xero Draft", () =>
    expect(resolve([row], [claim])).toEqual({
      ordinal: 2,
      invoiceNumber: "INV-77-EH2",
      holdReason: null,
    }));
  it.each(["reserved", "submitted", "reconciliation_required", "held"])(
    "uncertain %s claim blocks a new period",
    status =>
      expect(resolve([], [{ ...claim, status }]).holdReason).toMatch(
        /pending or uncertain/
      )
  );
  it("deleted prior AP Draft is a hold, not reusable or adoptable", () =>
    expect(
      resolve([{ ...row, Status: "DELETED" }], [claim]).holdReason
    ).toMatch(/deleted\/voided/));
  it("collision at next ordinal does not jump to EH3", () =>
    expect(
      resolve(
        [
          row,
          {
            ...row,
            InvoiceNumber: "INV-77-EH2",
            InvoiceID: "collision",
            Status: "VOIDED",
          },
        ],
        [claim]
      ).invoiceNumber
    ).toBeNull());
  it("shadow-like unclaimed rows cannot satisfy ordinal eligibility", () =>
    expect(
      resolve([], [{ ...claim, claimedInvoiceNumber: null }])
    ).toMatchObject({ ordinal: 1 }));
  it("duplicate/current period, ordinal gaps, missing Drafts and changed date are held", () => {
    expect(resolve([row], [claim], true, "2026-01-01").holdReason).toMatch(
      /already/
    );
    expect(resolve([], [{ ...claim, ordinal: 2 }]).holdReason).toMatch(
      /incomplete/
    );
    expect(resolve([], [claim]).holdReason).toMatch(/missing/);
    expect(resolve([row], [claim], true, "2026-02-01").holdReason).toMatch(
      /exactly 30/
    );
    expect(resolve([row, row], [claim]).holdReason).toMatch(/duplicated/);
  });
});
