import { afterEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ verify: vi.fn(), auth: vi.fn() }));
vi.mock("./financialDepositInvoiceDb", () => ({
  verifyDepositInvoiceAutomaticWriteAccess: m.verify,
}));
vi.mock("./xeroService", () => ({
  EXPECTED_AP_XERO_TENANT_LABEL: "CONTAINERZONE",
  getXeroReadAuthWithRefresh: m.auth,
}));
import {
  assertFinancialDraftWriteAuthorised,
  executeFinancialDraftWrite,
  type FinancialDraftPayload,
} from "./financialProductionWriter";
import {
  assertDepositInvoiceRelease,
  resolveDepositInvoiceRelease,
} from "./financialDepositInvoiceRelease";
import { DEPOSIT_INVOICE_RULES_HASH } from "./financialDepositInvoiceDrafts";
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
const context = () => ({
  workflowType: "deposit_invoice",
  approvalReference: "DEPOSIT-test",
  globalShadowMode: false,
  familyLiveEnabled: true,
  releaseManifestApproved: true,
  cutoverPackApproved: true,
  currentDocumentPreflightPassed: true,
  legacyWriterHandoffComplete: true,
  depositInvoiceAutomaticEventId: 61,
  depositInvoiceReleaseKey: "DEPOSIT-test",
  depositInvoiceApprovedBy: 7,
});
const payload = (): FinancialDraftPayload => ({
  method: "POST",
  endpoint: "/Invoices",
  documentFamily: "customer_invoice",
  documentNumber: "INV-123-D",
  expectedXeroDocumentId: null,
  idempotencyKey: "a".repeat(64),
  body: {
    Invoices: [
      {
        InvoiceNumber: "INV-123-D",
        Type: "ACCREC",
        Status: "DRAFT",
        CurrencyCode: "AUD",
        LineAmountTypes: "Inclusive",
        Contact: { ContactID: "customer" },
        LineItems: [
          {
            ItemCode: "Deposit Required",
            Description: "Deposit Required",
            Quantity: 1,
            UnitAmount: 110,
            AccountCode: "201",
            TaxType: "OUTPUT",
          },
        ],
      },
    ],
  },
});
describe("Deposit independent writer gate", () => {
  it("does not inherit global/all-family, Main invoice, Asset or other releases", () => {
    vi.stubEnv("FINANCIAL_LIVE_WRITES_ENABLED", "true");
    vi.stubEnv("FINANCIAL_MAIN_CUSTOMER_INVOICE_AUTOMATIC_ENABLED", "true");
    vi.stubEnv("FINANCIAL_ASSET_PURCHASE_AUTOMATIC_ENABLED", "true");
    expect(() =>
      assertFinancialDraftWriteAuthorised(context(), {
        requireExecutionId: false,
      })
    ).toThrow(/Deposit Invoice automatic release/);
    const {
      depositInvoiceAutomaticEventId,
      depositInvoiceReleaseKey,
      depositInvoiceApprovedBy,
      ...generic
    } = context();
    expect(() =>
      assertFinancialDraftWriteAuthorised(generic, {
        requireExecutionId: false,
      })
    ).toThrow(/Deposit Invoice automatic release/);
    vi.stubEnv("FINANCIAL_DEPOSIT_INVOICE_AUTOMATIC_ENABLED", "true");
    expect(() =>
      assertFinancialDraftWriteAuthorised(context(), {
        requireExecutionId: false,
      })
    ).not.toThrow();
    expect(() =>
      assertFinancialDraftWriteAuthorised(
        { ...context(), workflowType: "main_customer_invoice" },
        { requireExecutionId: false }
      )
    ).toThrow(/Deposit Invoice automatic release/);
    expect(() =>
      assertFinancialDraftWriteAuthorised(
        { ...context(), assetPurchaseAutomaticEventId: 1 },
        { requireExecutionId: false }
      )
    ).toThrow(/Deposit Invoice automatic release/);
    expect(() => assertFinancialDraftWriteAuthorised(context())).toThrow(
      /execution ledger/
    );
  });
  it("rejects updates, non-Drafts, wrong family/number, exclusive amounts and negative deduction lines before transport", async () => {
    vi.stubEnv("FINANCIAL_DEPOSIT_INVOICE_AUTOMATIC_ENABLED", "true");
    const invalid: FinancialDraftPayload[] = [
      { ...payload(), method: "PUT", expectedXeroDocumentId: "main-id" },
      { ...payload(), documentNumber: "INV-123" },
      { ...payload(), documentFamily: "purchase_order" },
    ];
    for (const patch of [
      { Status: "AUTHORISED" },
      { LineAmountTypes: "Exclusive" },
      { InvoiceNumber: "INV-123-D-A" },
      {
        LineItems: [
          {
            ItemCode: "Deposit Required",
            Quantity: 1,
            UnitAmount: -110,
            TaxType: "OUTPUT",
            AccountCode: "201",
          },
        ],
      },
    ])
      invalid.push({
        ...payload(),
        body: {
          Invoices: [{ ...(payload().body.Invoices as any[])[0], ...patch }],
        },
      });
    for (const input of invalid)
      await expect(
        executeFinancialDraftWrite(input, { ...context(), executionId: 1 })
      ).rejects.toThrow(/only one new exact/);
    expect(m.verify).not.toHaveBeenCalled();
    expect(m.auth).not.toHaveBeenCalled();
  });
  it("requires immutable reservation verification before any Xero authentication/transport", async () => {
    vi.stubEnv("FINANCIAL_DEPOSIT_INVOICE_AUTOMATIC_ENABLED", "true");
    m.verify.mockRejectedValue(new Error("Payload changed"));
    await expect(
      executeFinancialDraftWrite(payload(), { ...context(), executionId: 1 })
    ).rejects.toThrow(/Payload changed/);
    expect(m.verify).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: 61,
        releaseKey: "DEPOSIT-test",
        preparedBy: 7,
      })
    );
    expect(m.auth).not.toHaveBeenCalled();
  });
  it("resolves missing policy default-off and requires all explicit new-events-only attestations", () => {
    expect(resolveDepositInvoiceRelease(null)).toMatchObject({
      enabled: false,
      migrationScope: "new_events_only",
      sourceMappingsConfirmed: false,
    });
    vi.stubEnv("FINANCIAL_DEPOSIT_INVOICE_AUTOMATIC_ENABLED", "true");
    const policy = resolveDepositInvoiceRelease({
      releaseKey: "DEPOSIT-test",
      rulesHash: DEPOSIT_INVOICE_RULES_HASH,
      enabled: true,
      approvedBy: 7,
      approvedAt: "2026-01-01T00:00:00Z",
      effectiveFrom: "2026-01-01T00:00:00Z",
      depositOnlyVtigerBranch: true,
      operationsDepositHandoff: true,
      sourceMappingsConfirmed: true,
      isolatedDraftOnlyApproved: true,
    });
    expect(() => assertDepositInvoiceRelease(policy)).not.toThrow();
    expect(() =>
      assertDepositInvoiceRelease({ ...policy, sourceMappingsConfirmed: false })
    ).toThrow(/mappings/);
    expect(() =>
      assertDepositInvoiceRelease(
        resolveDepositInvoiceRelease({ ...policy, migrationScope: "backfill" })
      )
    ).toThrow(/disabled/);
  });
});
