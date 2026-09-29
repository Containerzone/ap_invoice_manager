import { beforeEach, describe, expect, it, vi } from "vitest";
import { proposalHash, rulesSnapshotHash, sourceSnapshotHash, xeroPreflightHash } from "./financialProposalIntegrity";
import { DEFAULT_FINANCIAL_AUTOMATION_RULES } from "./financialAutomationRules";

const mocks = vi.hoisted(() => ({
  getDetail: vi.fn(), getConfig: vi.fn(), createApproval: vi.fn(), retrieve: vi.fn(), mapSource: vi.fn(), evaluate: vi.fn(), preflight: vi.fn(),
}));

vi.mock("./financialWorkflowDb", () => ({
  getFinancialDocumentIntentDetail: mocks.getDetail,
  getFinancialWorkflowConfig: mocks.getConfig,
  createFinancialExecutionApproval: mocks.createApproval,
}));
vi.mock("./vtigerFinancialReadService", () => ({ retrieveCurrentVtigerFinancialRecord: mocks.retrieve }));
vi.mock("./financialShadowValidation", () => ({ mapVtigerFinancialSource: mocks.mapSource }));
vi.mock("./financialWorkflowEngine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./financialWorkflowEngine")>();
  return { ...actual, evaluateFinancialWorkflow: mocks.evaluate };
});
vi.mock("./financialReadOnlyXeroService", () => ({ preflightFinancialXeroIntents: mocks.preflight }));

import { approveFinancialExecution, previewFinancialExecutionApproval } from "./financialApprovalService";

const document = {
  documentFamily: "customer_invoice" as const,
  documentType: "main_invoice",
  proposedAction: "create_draft" as const,
  proposedDocumentNumber: "INV-7003",
  reference: "D7003",
  partyName: "Customer Pty Ltd",
  partySourceId: null,
  accountCode: "200",
  gstTreatment: "GST_EXCLUSIVE" as const,
  currency: "AUD" as const,
  issueDate: null,
  dueDate: null,
  subtotal: 100,
  taxAmount: 10,
  total: 110,
  lineItems: [{ itemCode: "SER1", description: "Service", quantity: 1, unitAmount: 100, lineAmount: 100, accountCode: "200", taxRate: 10, gstTreatment: "GST_EXCLUSIVE" as const }],
  validationStatus: "valid" as const,
  sourceWorkflow: "main_customer_invoice" as const,
  sourceRecordId: "4x7003",
};
const rawSource = { id: "4x7003", dealno: "D7003" };
const mappedSource = { customerName: "Customer Pty Ltd", invoiceNumber: "INV-7003" };
const sourceData = { ...mappedSource, _shadowRawSource: rawSource, _shadowAppliedMappings: ["test"] };
const preflight = {
  documentNumber: "INV-7003", documentFamily: "customer_invoice" as const,
  duplicateState: "not_found" as const, xeroDocumentId: null, status: null, partyName: null,
  itemChecks: [{ itemCode: "SER1", found: true, purchaseUnitPrice: null, salesUnitPrice: 100, nativeDescription: "Service" }],
  contactCheck: { partyName: "Customer Pty Ltd", found: true, count: 1, contactId: "contact-verified" }, error: null,
};

function detail(overrides: Record<string, unknown> = {}) {
  return {
    run: { id: 73, workflowType: "main_customer_invoice", sourceRecordId: "4x7003", sourceRecordNumber: "D7003", sourceRecordType: "Potentials" },
    intent: {
      id: 703, workflowRunId: 73, documentType: document.documentType, documentFamily: document.documentFamily,
      proposedAction: document.proposedAction, proposedDocumentNumber: document.proposedDocumentNumber,
      partyName: document.partyName, validationStatus: "valid",
      sourceSnapshotHash: sourceSnapshotHash(sourceData), rulesSnapshotHash: rulesSnapshotHash(DEFAULT_FINANCIAL_AUTOMATION_RULES),
      proposalHash: proposalHash(document), xeroPreflightHash: xeroPreflightHash(preflight), ...overrides,
    },
  };
}

describe("financial approval service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getConfig.mockResolvedValue([]);
    mocks.retrieve.mockResolvedValue(rawSource);
    mocks.mapSource.mockReturnValue({ sourceData: mappedSource, appliedMappings: ["test"] });
    mocks.evaluate.mockReturnValue({ outcome: "valid", issues: [], intents: [document] });
    mocks.preflight.mockResolvedValue([preflight]);
    mocks.getDetail.mockResolvedValue(detail());
    mocks.createApproval.mockResolvedValue({ id: 1, approvalKey: "faa-test", status: "approved" });
  });

  it("requires unchanged source, rules, payload and Xero preflight evidence", async () => {
    const preview = await previewFinancialExecutionApproval(703);
    expect(preview).toMatchObject({ approvalEligible: true, proposedDocumentNumber: "INV-7003" });
    expect(mocks.preflight).toHaveBeenCalledTimes(1);

    mocks.getDetail.mockResolvedValue(detail({ xeroPreflightHash: "stale" }));
    const changed = await previewFinancialExecutionApproval(703);
    expect(changed.approvalEligible).toBe(false);
    expect(changed.blockers.join(" ")).toContain("exact Xero duplicate/contact/item/Draft preflight");
  });

  it("records a short-lived local approval without invoking any financial writer", async () => {
    const result = await approveFinancialExecution({
      intentId: 703, approvalReference: "FIN-APP-703", acknowledgement: "I approve exactly this refreshed source, proposal and Xero preflight for the named Draft only.", actorId: 9,
    });
    expect(result).toMatchObject({ xeroWritePermitted: false, mode: "approved_but_unroutable" });
    expect(mocks.createApproval).toHaveBeenCalledWith(expect.objectContaining({
      documentIntentId: 703, proposedDocumentNumber: "INV-7003", approvedBy: 9,
    }));
  });
});
