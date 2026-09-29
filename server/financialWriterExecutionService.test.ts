import { afterEach, describe, expect, it } from "vitest";
import { FinancialWriteDisabledError } from "./financialProductionWriter";
import {
  executeGuardedFinancialWriterCommand,
  financialWriteOutcomeIsUncertain,
} from "./financialWriterExecutionService";

const payload = {
  endpoint: "/PurchaseOrders" as const,
  method: "POST" as const,
  documentFamily: "purchase_order" as const,
  documentNumber: "H1860",
  expectedXeroDocumentId: null,
  idempotencyKey: "a".repeat(64),
  body: { PurchaseOrders: [] },
};

const command = {
  workflowType: "container_control_acquisition",
  proposedAction: "create_draft" as const,
  payload,
  authorisation: {
    workflowType: "container_control_acquisition",
    approvalReference: "example-only",
    globalShadowMode: false,
    familyLiveEnabled: true,
    releaseManifestApproved: true,
    cutoverPackApproved: true,
    currentDocumentPreflightPassed: true,
    legacyWriterHandoffComplete: true,
  },
  preparedBy: 1,
};

describe("guarded financial writer coordinator", () => {
  const original = process.env.FINANCIAL_LIVE_WRITES_ENABLED;
  afterEach(() => {
    if (original === undefined) delete process.env.FINANCIAL_LIVE_WRITES_ENABLED;
    else process.env.FINANCIAL_LIVE_WRITES_ENABLED = original;
  });

  it("recognises only gateway failures as uncertain outcomes requiring read-back reconciliation", () => {
    expect(financialWriteOutcomeIsUncertain({ response: { status: 504 } })).toBe(true);
    expect(financialWriteOutcomeIsUncertain(new Error("Request failed with status code 502"))).toBe(true);
    expect(financialWriteOutcomeIsUncertain({ response: { status: 400 } })).toBe(false);
    expect(financialWriteOutcomeIsUncertain(new Error("invalid contact"))).toBe(false);
  });

  it("remains non-executable while the environment lock is absent", async () => {
    delete process.env.FINANCIAL_LIVE_WRITES_ENABLED;
    await expect(executeGuardedFinancialWriterCommand(command)).rejects.toBeInstanceOf(FinancialWriteDisabledError);
  });

  it("rejects a request if global shadow mode is still active, even with the environment flag", async () => {
    process.env.FINANCIAL_LIVE_WRITES_ENABLED = "true";
    await expect(executeGuardedFinancialWriterCommand({
      ...command,
      authorisation: { ...command.authorisation, globalShadowMode: true },
    })).rejects.toBeInstanceOf(FinancialWriteDisabledError);
  });
});
