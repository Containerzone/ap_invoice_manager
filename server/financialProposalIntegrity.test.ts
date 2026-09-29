import { describe, expect, it } from "vitest";
import {
  materialProposalDifferences,
  proposalHash,
  rulesSnapshotHash,
  sourceSnapshotHash,
  stableFinancialJson,
  xeroPreflightHash,
} from "./financialProposalIntegrity";
import { DEFAULT_FINANCIAL_AUTOMATION_RULES } from "./financialAutomationRules";

describe("financial proposal integrity", () => {
  const document = {
    documentFamily: "customer_invoice" as const,
    documentType: "main_invoice",
    proposedAction: "create_draft" as const,
    proposedDocumentNumber: "INV-7001",
    reference: "Q-1",
    partyName: "Customer Pty Ltd",
    partySourceId: null,
    accountCode: "200",
    gstTreatment: "GST_EXCLUSIVE" as const,
    currency: "AUD" as const,
    subtotal: 100,
    taxAmount: 10,
    total: 110,
    issueDate: new Date("2026-10-01T00:00:00.000Z"),
    dueDate: new Date("2026-10-15T00:00:00.000Z"),
    lineItems: [{ itemCode: "SER1", description: "Service", quantity: 1, unitAmount: 100, lineAmount: 100, accountCode: "200", taxRate: 10, gstTreatment: "GST_EXCLUSIVE" as const }],
    sourceWorkflow: "main_customer_invoice" as const,
    sourceRecordId: "4x7001",
    validationStatus: "valid" as const,
  };
  const preflight = {
    documentNumber: "INV-7001",
    documentFamily: "customer_invoice" as const,
    duplicateState: "not_found" as const,
    xeroDocumentId: null,
    status: null,
    partyName: null,
    itemChecks: [{ itemCode: "SER1", found: true, purchaseUnitPrice: null, salesUnitPrice: 100, nativeDescription: "Service" }],
    contactCheck: { partyName: "Customer Pty Ltd", found: true, count: 1, contactId: "contact-1" },
    error: null,
  };

  it("uses stable key-order-independent hashes for immutable audit fields", () => {
    expect(stableFinancialJson({ b: 2, a: 1 })).toBe(stableFinancialJson({ a: 1, b: 2 }));
    expect(sourceSnapshotHash({ b: 2, a: 1 })).toBe(sourceSnapshotHash({ a: 1, b: 2 }));
    expect(proposalHash(document)).toMatch(/^[a-f0-9]{64}$/);
    expect(rulesSnapshotHash(DEFAULT_FINANCIAL_AUTOMATION_RULES)).toMatch(/^[a-f0-9]{64}$/);
    expect(xeroPreflightHash(preflight)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("identifies every material proposal change before an approval can be reused", () => {
    const source = sourceSnapshotHash({ dealNumber: "D7001" });
    const rules = rulesSnapshotHash(DEFAULT_FINANCIAL_AUTOMATION_RULES);
    const proposal = proposalHash(document);
    const preflightHash = xeroPreflightHash(preflight);
    expect(materialProposalDifferences({
      sourceHash: source,
      rulesHash: rules,
      proposalHashValue: proposal,
      preflightHash,
      approval: { sourceSnapshotHash: source, rulesSnapshotHash: rules, proposalHash: proposal, xeroPreflightHash: preflightHash },
    })).toEqual([]);
    expect(materialProposalDifferences({
      sourceHash: `${source.slice(0, -1)}0`,
      rulesHash: rules,
      proposalHashValue: `${proposal.slice(0, -1)}1`,
      preflightHash,
      approval: { sourceSnapshotHash: source, rulesSnapshotHash: rules, proposalHash: proposal, xeroPreflightHash: preflightHash },
    })).toEqual(expect.arrayContaining(["the current VTiger source snapshot", "the proposed Xero Draft payload"]));
  });
});
