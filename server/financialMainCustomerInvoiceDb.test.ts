import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ getDb: vi.fn(), policy: vi.fn(), assertPolicy: vi.fn(), selectRows: [] as any[], updateSet: vi.fn(), updateWhere: vi.fn() }));
vi.mock("./db", () => ({ getDb: m.getDb }));
vi.mock("./financialMainCustomerInvoiceRelease", () => ({ getMainCustomerInvoiceReleasePolicy: m.policy, assertMainCustomerInvoiceRelease: m.assertPolicy }));

import {
  bindMainCustomerInvoicePayload,
  mainCustomerInvoicePayloadHash,
  verifyMainCustomerInvoiceAutomaticWriteAccess,
} from "./financialMainCustomerInvoiceDb";
import { prepareFinancialDraftPayload, type FinancialDraftPayload } from "./financialProductionWriter";
import { financialSha256 } from "./financialProposalIntegrity";

const payload = (): FinancialDraftPayload => ({
  endpoint: "/Invoices",
  method: "POST",
  documentFamily: "customer_invoice",
  documentNumber: "INV-702999",
  expectedXeroDocumentId: null,
  idempotencyKey: "a".repeat(64),
  body: { Invoices: [{
    InvoiceID: undefined,
    Type: "ACCREC",
    InvoiceNumber: "INV-702999",
    Reference: "Q702999",
    Contact: { ContactID: "xero-customer" },
    Status: "DRAFT",
    Date: "2026-11-13",
    DueDate: "2026-11-15",
    LineAmountTypes: "Exclusive",
    CurrencyCode: "AUD",
    LineItems: [{ ItemCode: "SER9", Description: "Loaded Container from A to B", Quantity: 1, UnitAmount: 100, AccountCode: "200", TaxType: "OUTPUT" }],
  }] },
});

const proposal = {
  documentFamily: "customer_invoice", documentType: "main_customer_invoice", proposedAction: "create_draft", proposedDocumentNumber: "INV-702999",
  reference: "Q702999", partyName: "Customer", partySourceId: "xero-customer", accountCode: "200", gstTreatment: "GST_EXCLUSIVE", currency: "AUD",
  subtotal: 100, taxAmount: 10, total: 110, issueDate: "2026-11-13T00:00:00.000Z", dueDate: "2026-11-15T00:00:00.000Z",
  lineItems: [{ itemCode: "SER9", description: "Loaded Container from A to B", quantity: 1, unitAmount: 100, lineAmount: 100, accountCode: "200", taxRate: 10, gstTreatment: "GST_EXCLUSIVE" }],
  sourceWorkflow: "main_customer_invoice", sourceRecordId: "5x999", validationStatus: "valid",
};

function bodyHash(value: unknown) {
  return financialSha256(value);
}

function event(overrides: Record<string, unknown> = {}) {
  return {
    id: 51, dealId: "5x999", proposedInvoiceNumber: "INV-702999", status: "reserved", processingToken: "exclusive-token",
    releaseKey: null, authorisedPayload: null, sourceSnapshotHash: "s".repeat(64), xeroPreflightHash: "p".repeat(64), proposal,
    ...overrides,
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  const db = {
    select: () => ({ from: () => ({ where: () => ({ limit: vi.fn(async () => m.selectRows) }), orderBy: vi.fn() }) }),
    update: () => ({ set: m.updateSet.mockImplementation((value: unknown) => ({ where: m.updateWhere.mockResolvedValue([{ affectedRows: 1 }]) })) }),
  };
  m.getDb.mockResolvedValue(db);
  m.policy.mockResolvedValue({ releaseKey: "MAIN-INV-test", enabled: true, approvedBy: 7, approvedAt: "2026-10-01T00:00:00.000Z", effectiveFrom: "2026-10-01T00:00:00.000Z", mainInvoiceOnlyVtigerBranch: true, operationsMainInvoiceHandoff: true });
  m.selectRows = [event()];
});

describe("Main Invoice immutable payload binding", () => {
  it("binds only the exact final AUD wire body to its exclusive reservation token", async () => {
    await bindMainCustomerInvoicePayload({ eventId: 51, token: "exclusive-token", releaseKey: "MAIN-INV-test", payload: payload() });

    expect(m.updateSet).toHaveBeenCalledWith(expect.objectContaining({
      releaseKey: "MAIN-INV-test",
      authorisedPayload: expect.objectContaining({ number: "INV-702999", bodyHash: bodyHash(payload().body) }),
    }));
  });

  it("binds the exact two-line D702959-like Main Invoice wire body while local totals use per-line GST", async () => {
    const twoLineProposal = {
      ...proposal,
      subtotal: 3821.32,
      taxAmount: 382.14,
      total: 4203.46,
      lineItems: [
        { itemCode: "20' Hire", description: "20 Foot Standard Height Container Hire per 30 days", quantity: 1, unitAmount: 224.75, lineAmount: 224.75, accountCode: "210", taxRate: 10, gstTreatment: "GST_EXCLUSIVE" },
        { itemCode: "SER60", description: "Empty & Loaded Container from Origin to Destination", quantity: 1, unitAmount: 3596.57, lineAmount: 3596.57, accountCode: "200", taxRate: 10, gstTreatment: "GST_EXCLUSIVE" },
      ],
    };
    const twoLinePayload = prepareFinancialDraftPayload({
      ...twoLineProposal,
      issueDate: new Date("2026-11-13T00:00:00.000Z"),
      dueDate: new Date("2026-11-15T00:00:00.000Z"),
    } as any, "d702959-test");
    (twoLinePayload.body.Invoices as any[])[0].CurrencyCode = "AUD";
    m.selectRows = [event({ proposal: twoLineProposal })];

    await expect(bindMainCustomerInvoicePayload({ eventId: 51, token: "exclusive-token", releaseKey: "MAIN-INV-test", payload: twoLinePayload })).resolves.toBeUndefined();
    expect((twoLinePayload.body.Invoices as any[])[0]).toMatchObject({
      Type: "ACCREC", Status: "DRAFT", CurrencyCode: "AUD", LineAmountTypes: "Exclusive",
      LineItems: [
        { ItemCode: "20' Hire", UnitAmount: 224.75, AccountCode: "210", TaxType: "OUTPUT" },
        { ItemCode: "SER60", UnitAmount: 3596.57, AccountCode: "200", TaxType: "OUTPUT" },
      ],
    });
  });

  it("accepts the production builder body after CurrencyCode is appended after LineItems", async () => {
    const document = {
      ...proposal,
      issueDate: new Date("2026-11-13T00:00:00.000Z"),
      dueDate: new Date("2026-11-15T00:00:00.000Z"),
    } as any;
    const productionPayload = prepareFinancialDraftPayload(document, "main-invoice-test");
    (productionPayload.body.Invoices as any[])[0].CurrencyCode = "AUD";

    await expect(bindMainCustomerInvoicePayload({ eventId: 51, token: "exclusive-token", releaseKey: "MAIN-INV-test", payload: productionPayload })).resolves.toBeUndefined();
  });

  it("rejects a contact, total or line mutation before it can bind a writer request", async () => {
    const variants = [
      (() => { const value = payload(); (value.body.Invoices as any[])[0].Contact.ContactID = "wrong"; return value; })(),
      (() => { const value = payload(); (value.body.Invoices as any[])[0].LineItems[0].UnitAmount = 101; return value; })(),
      (() => { const value = payload(); (value.body.Invoices as any[])[0].DueDate = "2026-11-16"; return value; })(),
    ];
    for (const altered of variants) {
      await expect(bindMainCustomerInvoicePayload({ eventId: 51, token: "exclusive-token", releaseKey: "MAIN-INV-test", payload: altered })).rejects.toThrow(/does not match/i);
    }
    expect(m.updateSet).not.toHaveBeenCalled();
  });

  it("rejects a stale or stolen token and a tampered body during the final pre-POST verification", async () => {
    const original = payload();
    const stored = event({
      releaseKey: "MAIN-INV-test",
      authorisedPayload: {
        hash: mainCustomerInvoicePayloadHash(original), number: original.documentNumber, bodyHash: bodyHash(original.body),
        sourceSnapshotHash: "s".repeat(64), xeroPreflightHash: "p".repeat(64),
      },
    });
    m.selectRows = [stored];
    await expect(verifyMainCustomerInvoiceAutomaticWriteAccess({ eventId: 51, token: "other-token", releaseKey: "MAIN-INV-test", payload: original, preparedBy: 7 })).rejects.toThrow(/exact-payload reservation/i);
    const altered = payload();
    (altered.body.Invoices as any[])[0].Reference = "different";
    await expect(verifyMainCustomerInvoiceAutomaticWriteAccess({ eventId: 51, token: "exclusive-token", releaseKey: "MAIN-INV-test", payload: altered, preparedBy: 7 })).rejects.toThrow(/exact-payload reservation/i);
  });
});
