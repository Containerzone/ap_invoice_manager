import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  original: vi.fn(),
  failedExecution: vi.fn(),
  classify: vi.fn(),
  policy: vi.fn(),
  preview: vi.fn(),
  reserve: vi.fn(),
  bind: vi.fn(),
  complete: vi.fn(),
  hold: vi.fn(),
  writer: vi.fn(),
}));

vi.mock("./financialMainCustomerInvoiceReconciliationDb", async original => ({
  ...(await original<any>()),
  getMainCustomerInvoiceReconciliationOriginal: m.original,
  getMainCustomerInvoiceReconciliationWriterEvidence: m.failedExecution,
  classifyMainCustomerInvoiceReconciliationOrigin: m.classify,
  reserveMainCustomerInvoiceReconciliation: m.reserve,
  bindMainCustomerInvoiceReconciliationPayload: m.bind,
  completeMainCustomerInvoiceReconciliation: m.complete,
  holdMainCustomerInvoiceReconciliation: m.hold,
}));
vi.mock("./financialMainCustomerInvoiceService", () => ({
  previewMainCustomerInvoice: m.preview,
}));
vi.mock("./financialMainCustomerInvoiceRelease", async original => ({
  ...(await original<any>()),
  getMainCustomerInvoiceReleasePolicy: m.policy,
}));
vi.mock("./financialWriterExecutionService", () => ({
  executeGuardedFinancialWriterCommand: m.writer,
}));

import {
  applyApprovedMainCustomerInvoiceReconciliation,
  previewMainCustomerInvoiceReconciliation,
} from "./financialMainCustomerInvoiceReconciliationService";
import {
  MAIN_CUSTOMER_INVOICE_RECONCILIATION_SCOPE,
  prepareMainCustomerInvoiceReconciliationPayload,
} from "./financialMainCustomerInvoiceReconciliationDb";
import { MAIN_CUSTOMER_INVOICE_RULES_HASH } from "./financialMainCustomerInvoiceDrafts";

const scope = MAIN_CUSTOMER_INVOICE_RECONCILIATION_SCOPE;

function originalEvent(patch: Record<string, unknown> = {}) {
  return {
    id: scope.originalEventId,
    dealId: scope.dealId,
    dealNumber: scope.dealNumber,
    quoteId: "20x946",
    quoteNumber: "Q-702946",
    proposedInvoiceNumber: scope.invoiceNumber,
    customerVtigerId: "4x946",
    customerName: "Recovery Customer Pty Ltd",
    sourceRefreshedAt: new Date("2026-10-18T00:00:00Z"),
    sourceSnapshotHash: "s".repeat(64),
    rulesSnapshotHash: MAIN_CUSTOMER_INVOICE_RULES_HASH,
    xeroPreflightHash: "x".repeat(64),
    proposal: { legacy: true },
    xeroPreflight: { legacy: true },
    xeroInvoiceId: null,
    releaseKey: "MAIN-test",
    authorisedPayload: {
      hash: "a".repeat(64),
      number: scope.invoiceNumber,
      bodyHash: "b".repeat(64),
    },
    processingToken: null,
    status: "reconciliation_required",
    holdReason:
      "Main Customer Invoice Xero execution requires exact reconciliation before any retry.",
    executionId: null,
    ...patch,
  };
}

function failedExecution(patch: Record<string, unknown> = {}) {
  return {
    id: scope.failedWriterExecutionId,
    executionKey: "FWX-LOCALVALIDATION",
    workflowType: "main_customer_invoice",
    documentFamily: "customer_invoice",
    proposedAction: "create_draft",
    proposedDocumentNumber: scope.invoiceNumber,
    targetXeroDocumentId: null,
    endpoint: "/Invoices",
    method: "POST",
    idempotencyKey: "i".repeat(64),
    payloadFingerprint: `${"i".repeat(24)}:POST:/Invoices`,
    status: "failed",
    approvalReference: "MAIN-test",
    safePayloadSummary: { documentNumber: scope.invoiceNumber },
    xeroDocumentId: null,
    xeroDocumentStatus: null,
    xeroResponseSummary: null,
    errorMessage: scope.validationError,
    preparedBy: 7,
    submittedAt: new Date("2026-10-18T00:00:00Z"),
    completedAt: new Date("2026-10-18T00:00:01Z"),
    ...patch,
  };
}

function proposal() {
  return {
    documentFamily: "customer_invoice" as const,
    documentType: "main_customer_invoice",
    proposedAction: "create_draft" as const,
    proposedDocumentNumber: scope.invoiceNumber,
    reference: "Q-702946",
    partyName: "Recovery Customer Pty Ltd",
    partySourceId: "xero-946",
    accountCode: "200",
    gstTreatment: "GST_EXCLUSIVE" as const,
    currency: "AUD",
    subtotal: 9029.15,
    taxAmount: 902.92,
    total: scope.total,
    issueDate: new Date("2026-10-18T00:00:00Z"),
    dueDate: new Date("2026-10-20T00:00:00Z"),
    lineItems: [
      {
        itemCode: "20' Hire",
        description: "20 Foot Container Hire",
        quantity: 1,
        unitAmount: 9029.15,
        lineAmount: 9029.15,
        accountCode: "210",
        taxRate: 10,
        gstTreatment: "GST_EXCLUSIVE" as const,
      },
    ],
    sourceWorkflow: "main_customer_invoice",
    sourceRecordId: scope.dealId,
    validationStatus: "valid" as const,
  };
}

function currentPreview(patch: Record<string, unknown> = {}) {
  const document = proposal();
  const preflight = {
    documentNumber: scope.invoiceNumber,
    duplicateState: "not_found",
    xeroDocumentId: null,
    status: null,
    partyName: null,
    contactCheck: {
      partyName: "Recovery Customer Pty Ltd",
      found: true,
      count: 1,
      contactId: "xero-946",
    },
    itemChecks: [
      {
        itemCode: "20' Hire",
        found: true,
        isSold: true,
        salesAccountCode: "210",
        salesTaxType: "OUTPUT",
      },
    ],
    error: null,
  };
  return {
    facts: { dealId: scope.dealId, dealNumber: scope.dealNumber },
    preview: {
      eligible: true,
      proposedInvoiceNumber: scope.invoiceNumber,
      document,
    },
    preflight,
    sourceSnapshotHash: "c".repeat(64),
    xeroPreflightHash: "p".repeat(64),
    state: "previewed",
    holdReason: null,
    noWrites: true,
    ...patch,
  };
}

function policy() {
  return {
    releaseKey: "MAIN-test",
    rulesHash: MAIN_CUSTOMER_INVOICE_RULES_HASH,
    enabled: true,
    approvedBy: 7,
    approvedAt: "2026-01-01T00:00:00Z",
    effectiveFrom: "2026-01-01T00:00:00Z",
    mainInvoiceOnlyVtigerBranch: true,
    operationsMainInvoiceHandoff: true,
    migrationScope: "new_events_only" as const,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.original.mockResolvedValue(originalEvent());
  m.failedExecution.mockResolvedValue(failedExecution());
  m.classify.mockReturnValue({
    dealId: scope.dealId,
    dealNumber: scope.dealNumber,
    invoiceNumber: scope.invoiceNumber,
    total: scope.total,
  });
  m.preview.mockResolvedValue(currentPreview());
  m.policy.mockResolvedValue(policy());
  m.reserve.mockResolvedValue({ state: "reserved", event: { id: 750002 } });
  m.writer.mockResolvedValue({
    outcome: "succeeded",
    executionId: 1110002,
    result: {
      documentNumber: scope.invoiceNumber,
      xeroDocumentId: "xero-946",
      status: "DRAFT",
    },
  });
});
afterEach(() => vi.unstubAllEnvs());

describe("D702946 Main Invoice isolated local-validation reconciliation", () => {
  it("uses current source and Xero GET-only preflight for the exact party, item and AUD 9,932.07 total without reserving or writing", async () => {
    const result = await previewMainCustomerInvoiceReconciliation(
      scope.originalEventId
    );
    expect(result).toMatchObject({
      originalEventId: 750001,
      failedWriterExecutionId: 1110001,
      dealId: "5x490313",
      dealNumber: "D702946",
      invoiceNumber: "INV-702946",
      noWrites: true,
    });
    expect(result.proposal).toMatchObject({
      partyName: "Recovery Customer Pty Ltd",
      partySourceId: "xero-946",
      total: 9932.07,
      lineItems: [
        expect.objectContaining({ itemCode: "20' Hire", accountCode: "210" }),
      ],
    });
    expect(m.preview).toHaveBeenCalledWith(scope.dealId);
    expect(m.reserve).not.toHaveBeenCalled();
    expect(m.writer).not.toHaveBeenCalled();
  });

  it.each([
    { state: "held" },
    { preflight: { ...currentPreview().preflight, duplicateState: "found" } },
    {
      preview: {
        eligible: true,
        proposedInvoiceNumber: scope.invoiceNumber,
        document: { ...proposal(), total: 9999 },
      },
    },
    {
      preflight: {
        ...currentPreview().preflight,
        contactCheck: {
          partyName: "Recovery Customer Pty Ltd",
          found: false,
          count: 0,
          contactId: null,
        },
      },
    },
  ])(
    "rejects changed source/Xero no-duplicate/party/total evidence before reserving %#",
    async patch => {
      m.preview.mockResolvedValue(currentPreview(patch));
      await expect(
        previewMainCustomerInvoiceReconciliation(scope.originalEventId)
      ).rejects.toThrow(/not eligible/);
      expect(m.reserve).not.toHaveBeenCalled();
      expect(m.writer).not.toHaveBeenCalled();
    }
  );

  it("is default-off and reads neither origin evidence nor creates a receipt when the dedicated gate is disabled", async () => {
    vi.stubEnv(
      "FINANCIAL_MAIN_CUSTOMER_INVOICE_RECONCILIATION_ENABLED",
      "false"
    );
    await expect(
      applyApprovedMainCustomerInvoiceReconciliation(scope.originalEventId)
    ).rejects.toThrow(/disabled/);
    expect(m.original).not.toHaveBeenCalled();
    expect(m.failedExecution).not.toHaveBeenCalled();
    expect(m.reserve).not.toHaveBeenCalled();
    expect(m.writer).not.toHaveBeenCalled();
  });

  it("reserves a distinct immutable recovery receipt only on the explicit execute call and sends no post-success CRM plan", async () => {
    vi.stubEnv(
      "FINANCIAL_MAIN_CUSTOMER_INVOICE_RECONCILIATION_ENABLED",
      "true"
    );
    const result = await applyApprovedMainCustomerInvoiceReconciliation(
      scope.originalEventId
    );
    expect(result).toMatchObject({
      ok: true,
      status: "drafts_created",
      eventId: 750002,
      executionId: 1110002,
      documentNumber: scope.invoiceNumber,
    });
    expect(m.reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        originalEventId: 750001,
        failedWriterExecutionId: 1110001,
        invoiceNumber: scope.invoiceNumber,
      })
    );
    expect(m.bind).toHaveBeenCalledWith(
      750002,
      expect.any(String),
      "MAIN-test",
      expect.objectContaining({
        documentNumber: scope.invoiceNumber,
        method: "POST",
        endpoint: "/Invoices",
      })
    );
    expect(m.writer).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowType: "main_invoice_reconciliation",
        authorisation: expect.objectContaining({
          mainInvoiceReconciliationEventId: 750002,
        }),
      })
    );
    expect(m.writer.mock.calls[0]![0]).not.toHaveProperty("sourceRecordId");
    expect(m.writer.mock.calls[0]![0]).not.toHaveProperty("postSuccessPlan");
    expect(m.complete).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 750002, executionId: 1110002 })
    );
  });

  it("uses a recovery-specific idempotency key distinct from the failed original execution", () => {
    const payload = prepareMainCustomerInvoiceReconciliationPayload(
      proposal(),
      scope.originalEventId,
      "c".repeat(64)
    );
    expect(payload.idempotencyKey).not.toBe(failedExecution().idempotencyKey);
    expect(payload).toMatchObject({
      documentNumber: scope.invoiceNumber,
      method: "POST",
      endpoint: "/Invoices",
      expectedXeroDocumentId: null,
    });
  });
});
