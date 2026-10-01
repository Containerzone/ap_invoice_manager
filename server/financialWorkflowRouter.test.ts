import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const evaluation = {
  workflowType: "main_customer_invoice",
  mode: "shadow",
  idempotencyKey: "safe-key",
  sourceSummary: {},
  intents: [],
  issues: [],
  outcome: "passed",
  safeRequestSummary: { xeroWritePermitted: false },
};

vi.mock("./financialWorkflowService", () => ({
  FINANCIAL_SHADOW_MODE: true,
  evaluateAndPersistFinancialWorkflow: vi.fn().mockResolvedValue({
    evaluation,
    persistence: { runId: 77, duplicate: false, intentIds: [], exceptionIds: [] },
  }),
}));

vi.mock("./financialWorkflowDb", () => ({
  addFinancialExceptionComment: vi.fn().mockResolvedValue(1),
  assignFinancialWorkflowException: vi.fn().mockResolvedValue(undefined),
  getFinancialDocumentIntents: vi.fn().mockResolvedValue([]),
  getFinancialDocuments: vi.fn().mockResolvedValue([]),
  getFinancialExceptionComments: vi.fn().mockResolvedValue([]),
  getFinancialOperationsDashboard: vi.fn().mockResolvedValue({
    runsToday: 0,
    proposedDocuments: 0,
    confirmedDraftDocuments: 0,
    failedOrHeld: 0,
    openExceptions: 0,
    shadowEvidence: 15,
    candidateLookups: 5,
    releaseManifests: 1,
    integrationChecks: 13,
    nextRecurringHire: null,
    nextStorage: null,
  }),
  getFinancialWorkflowConfig: vi.fn().mockResolvedValue([]),
  getFinancialWorkflowConfigAudits: vi.fn().mockResolvedValue([]),
  createFinancialCandidateDiscovery: vi.fn().mockResolvedValue(33),
  createDisabledFinancialCutoverPack: vi.fn().mockResolvedValue({ packId: 44, controlId: 55 }),
  createFinancialIntegrationAudit: vi.fn().mockResolvedValue(44),
  getFinancialCutoverAudits: vi.fn().mockResolvedValue([]),
  getFinancialCutoverControls: vi.fn().mockResolvedValue([]),
  getFinancialCutoverPacks: vi.fn().mockResolvedValue([]),
  createFinancialShadowTest: vi.fn().mockResolvedValue(901),
  getFinancialCandidateDiscoveries: vi.fn().mockResolvedValue([]),
  getFinancialCandidateRoster: vi.fn().mockResolvedValue([]),
  getFinancialCandidateRosterEntry: vi.fn().mockResolvedValue(undefined),
  getFinancialIntegrationAudits: vi.fn().mockResolvedValue([]),
  getFinancialShadowTestById: vi.fn().mockResolvedValue({ id: 901, reviewStatus: "pending", actualResult: { reviewEligible: true } }),
  getFinancialShadowTests: vi.fn().mockResolvedValue([]),
  getFinancialWorkflowExceptions: vi.fn().mockResolvedValue([]),
  getFinancialWorkflowRunDetail: vi.fn().mockResolvedValue(undefined),
  getFinancialWorkflowRuns: vi.fn().mockResolvedValue([]),
  getFinancialWorkflowSchedules: vi.fn().mockResolvedValue([]),
  resolveFinancialWorkflowException: vi.fn().mockResolvedValue(undefined),
  reviewFinancialShadowTest: vi.fn().mockResolvedValue(undefined),
  upsertFinancialCandidateRosterEntry: vi.fn().mockResolvedValue(71),
  updateFinancialCandidateRosterDiscovery: vi.fn().mockResolvedValue(undefined),
  markFinancialCandidateRosterNeedsData: vi.fn().mockResolvedValue(undefined),
  linkFinancialCandidateRosterShadowTest: vi.fn().mockResolvedValue(undefined),
  getFinancialReleaseManifest: vi.fn().mockResolvedValue(undefined),
  getFinancialReleaseManifests: vi.fn().mockResolvedValue([]),
  prepareAllFinancialReleaseManifest: vi.fn().mockResolvedValue({
    manifest: { id: 88, releaseId: "AFO-REL-TEST" }, families: [], audits: [],
  }),
  recordFinancialReleaseLegacyInventory: vi.fn().mockResolvedValue({ id: 99, legacyWriterIdentifier: "legacy-workflow" }),
  upsertFinancialWorkflowConfig: vi.fn().mockResolvedValue(undefined),
  upsertFinancialWorkflowSchedule: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./vtigerFinancialReadService", () => ({
  getVtigerFinancialConnectionStatus: vi.fn().mockReturnValue({ configured: true, missing: [] }),
  testVtigerFinancialConnection: vi.fn().mockResolvedValue({ configured: true, missing: [], outcome: "passed", message: "VTiger read-only access passed", checkedAt: new Date() }),
  retrieveCurrentVtigerFinancialRecord: vi.fn().mockResolvedValue({ customerOrganisationName: "Current customer", modifiedtime: "2026-09-25 12:00:00" }),
}));

vi.mock("./vtigerFinancialCandidateService", () => ({
  findExactFinancialCandidate: vi.fn().mockResolvedValue({
    outcome: "found", sourceCategory: "deal", businessNumber: "D702903", message: "Exact match", candidates: [{
      recordId: "4x702903", module: "Potentials", matchedField: "potentials_no", sourceCategory: "deal", businessNumber: "D702903", sourceRefreshedAt: new Date(), summary: { potentials_no: "D702903" },
    }],
  }),
  getFinancialCandidateFinderConfig: vi.fn().mockReturnValue({ deal: [], container_control: [] }),
}));

vi.mock("./financialReadOnlyXeroService", () => ({
  getFinancialXeroConnectionStatus: vi.fn().mockResolvedValue({ configured: true, tokenState: "valid" }),
  testFinancialXeroConnection: vi.fn().mockResolvedValue({ outcome: "passed", message: "Xero read-only access passed", tenantId: "tenant-1", organisationName: "CONTAINERZONE", expectedTenantLabel: "CONTAINERZONE", checkedAt: new Date() }),
  preflightFinancialXeroIntents: vi.fn().mockResolvedValue([]),
  previewHistoricalXeroReferences: vi.fn().mockResolvedValue([]),
}));

vi.mock("./financialLiveExecutionService", () => ({
  getFinancialExecutionGateState: vi.fn().mockResolvedValue({ approvalId: 71, gates: { allPassed: false } }),
  isFinancialGlobalShadowModeEnabled: () => true,
}));

function context(role: "admin" | "user"): TrpcContext {
  return {
    user: {
      id: role === "admin" ? 1 : 2, openId: `${role}-id`, name: role, email: `${role}@example.com`, loginMethod: "manus", role,
      createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(), status: "active",
    },
    req: {} as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };
}

describe("financial operations tRPC safeguards", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps evidence-only records visible when no trigger evaluation has run", async () => {
    const { appRouter } = await import("./routers");
    const result = await appRouter.createCaller(context("admin")).financialOperations.dashboard();
    expect(result).toMatchObject({
      runsToday: 0,
      proposedDocuments: 0,
      shadowEvidence: 15,
      candidateLookups: 5,
      releaseManifests: 1,
      integrationChecks: 13,
    });
  });

  it("shows storage receiver and writer lock without exposing secrets or changing Operations", async () => {
    const { appRouter } = await import("./routers");
    const existing = process.env.FINANCIAL_INITIAL_STORAGE_ENABLED;
    try {
      delete process.env.FINANCIAL_INITIAL_STORAGE_ENABLED;
      await expect(appRouter.createCaller(context("user")).financialOperations.initialStorageReadiness())
        .rejects.toMatchObject({ code: "FORBIDDEN" });
      const status = await appRouter.createCaller(context("admin")).financialOperations.initialStorageReadiness();
      expect(status).toMatchObject({ endpointPath: "/api/webhooks/vtiger/deal-storage",
        namedPilotWriteGateArmed: false, legacyOriginDestinationWriter: "not_verified_in_ap",
        vtigerDelivery: "not_verified_in_ap", scheduleRequired: false });
      expect(Object.keys(status)).not.toContain("secret");
    } finally {
      if (existing === undefined) delete process.env.FINANCIAL_INITIAL_STORAGE_ENABLED;
      else process.env.FINANCIAL_INITIAL_STORAGE_ENABLED = existing;
    }
  });

  it("rejects staff and broad, non-exact storage previews before VTiger access", async () => {
    const { appRouter } = await import("./routers");
    await expect(appRouter.createCaller(context("user")).financialOperations.previewInitialStorage({ exactDeal: "D702885" }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(appRouter.createCaller(context("admin")).financialOperations.previewInitialStorage({ exactDeal: "D%" }))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("permits an admin dry run and returns an explicit no-write result", async () => {
    const { appRouter } = await import("./routers");
    const { evaluateAndPersistFinancialWorkflow } = await import("./financialWorkflowService");
    const caller = appRouter.createCaller(context("admin"));
    const result = await caller.financialOperations.dryRun({
      workflowType: "main_customer_invoice", sourceRecordId: "deal-1", sourceData: { customerOrganisationName: "Customer" }, reEvaluationKey: "manual-1",
    });
    expect(result).toMatchObject({ mode: "shadow", xeroWritePermitted: false, financialShadowMode: true });
    expect(evaluateAndPersistFinancialWorkflow).toHaveBeenCalledWith(expect.objectContaining({ triggerType: "re_evaluation", workflowType: "main_customer_invoice" }), 1);
  });

  it("does not grant staff the ability to create financial dry runs or change mappings", async () => {
    const { appRouter } = await import("./routers");
    const caller = appRouter.createCaller(context("user"));
    await expect(caller.financialOperations.dryRun({ workflowType: "main_customer_invoice", sourceData: {} })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.financialOperations.saveConfig({ configKey: "warranty.mappings", configValue: {} })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("accepts only disabled financial target schedule metadata in phase one", async () => {
    const { appRouter } = await import("./routers");
    const caller = appRouter.createCaller(context("admin"));
    await expect(caller.financialOperations.saveDisabledSchedule({ workflowType: "recurring_for_hire", enabled: false })).resolves.toMatchObject({ enabled: false, mode: "shadow" });
    await expect(caller.financialOperations.saveDisabledSchedule({ workflowType: "recurring_for_hire", enabled: true as never })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("allows only an administrator to pause AP webhook proposal processing", async () => {
    const { appRouter } = await import("./routers");
    const { upsertFinancialWorkflowConfig } = await import("./financialWorkflowDb");
    await expect(appRouter.createCaller(context("user")).financialOperations.setWebhookPause({ routeKey: "global", paused: true }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(appRouter.createCaller(context("admin")).financialOperations.setWebhookPause({ routeKey: "main-customer-invoice", paused: true }))
      .resolves.toMatchObject({ mode: "proposal_only", xeroWritePermitted: false, sourceSystemsChanged: false, schedulesChanged: false });
    expect(upsertFinancialWorkflowConfig).toHaveBeenCalledWith(
      "financial-automation.webhook-controls",
      expect.objectContaining({ familyPaused: expect.objectContaining({ "main-customer-invoice": true }) }),
      expect.any(String),
      1,
    );
  });

  it("supports a read-only administrator-triggered re-evaluation of a current VTiger record", async () => {
    const { appRouter } = await import("./routers");
    const { retrieveCurrentVtigerFinancialRecord } = await import("./vtigerFinancialReadService");
    const { evaluateAndPersistFinancialWorkflow } = await import("./financialWorkflowService");
    const result = await appRouter.createCaller(context("admin")).financialOperations.refreshCurrentVtigerRecord({
      workflowType: "main_customer_invoice", vtigerRecordId: "4x12345", sourceRecordNumber: "D700001",
    });
    expect(result).toMatchObject({ mode: "shadow", xeroWritePermitted: false });
    expect(retrieveCurrentVtigerFinancialRecord).toHaveBeenCalledWith("4x12345");
    expect(evaluateAndPersistFinancialWorkflow).toHaveBeenCalledWith(expect.objectContaining({
      triggerType: "re_evaluation", sourceRecordId: "4x12345", sourceData: expect.objectContaining({ customerOrganisationName: "Current customer" }),
    }), 1);
  });

  it("records a named current-record shadow test with no Xero write permission", async () => {
    const { appRouter } = await import("./routers");
    const { preflightFinancialXeroIntents } = await import("./financialReadOnlyXeroService");
    const { createFinancialShadowTest } = await import("./financialWorkflowDb");
    const result = await appRouter.createCaller(context("admin")).financialOperations.validateCurrentVtigerRecord({
      workflowType: "main_customer_invoice", branch: "Main customer invoice", vtigerRecordId: "4x12345", sourceRecordNumber: "D700001",
      expectedResult: { proposedDocumentNumbers: ["INV-700001"] },
    });
    expect(result).toMatchObject({ mode: "shadow", xeroWritePermitted: false, xeroWriteMethodsCalled: [], testId: 901 });
    expect(preflightFinancialXeroIntents).toHaveBeenCalledWith([]);
    expect(createFinancialShadowTest).toHaveBeenCalledWith(expect.objectContaining({
      sourceRecordNumber: "D700001", xeroPreflight: expect.objectContaining({ readOnly: true, xeroWriteMethodsCalled: [] }),
    }));
  });

  it("records an exact named candidate lookup without exposing a live writer", async () => {
    const { appRouter } = await import("./routers");
    const { createFinancialCandidateDiscovery } = await import("./financialWorkflowDb");
    const result = await appRouter.createCaller(context("admin")).financialOperations.findVtigerCandidate({
      sourceCategory: "deal", businessNumber: "D702903", workflowType: "main_customer_invoice",
    });
    expect(result).toMatchObject({ outcome: "found", discoveryId: 33, xeroWritePermitted: false });
    expect(createFinancialCandidateDiscovery).toHaveBeenCalledWith(expect.objectContaining({
      businessNumber: "D702903", candidateRecordIds: ["4x702903"], initiatedBy: 1,
    }));
  });

  it("allows only an administrator to add one explicit Candidate Roster entry", async () => {
    const { appRouter } = await import("./routers");
    const { upsertFinancialCandidateRosterEntry } = await import("./financialWorkflowDb");
    const input = {
      sourceCategory: "container_control" as const,
      businessNumber: "CC-2001",
      workflowType: "recurring_for_hire" as const,
      branch: "Initial For Hire",
      businessNote: "Known current candidate",
    };
    await expect(appRouter.createCaller(context("user")).financialOperations.saveCandidateRosterEntry(input)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(appRouter.createCaller(context("admin")).financialOperations.saveCandidateRosterEntry(input)).resolves.toMatchObject({ rosterEntryId: 71, xeroWritePermitted: false });
    expect(upsertFinancialCandidateRosterEntry).toHaveBeenCalledWith(expect.objectContaining({ ...input, createdBy: 1 }));
  });

  it("resolves only the exact named Candidate Roster reference and stores no live writer result", async () => {
    const { appRouter } = await import("./routers");
    const { getFinancialCandidateRosterEntry, updateFinancialCandidateRosterDiscovery } = await import("./financialWorkflowDb");
    vi.mocked(getFinancialCandidateRosterEntry).mockResolvedValueOnce({
      id: 71, sourceCategory: "container_control", businessNumber: "CC-2001", workflowType: "container_control_acquisition", branch: "Initial For Hire", createdBy: 1,
    } as any);
    const result = await appRouter.createCaller(context("admin")).financialOperations.resolveCandidateRosterEntry({ rosterEntryId: 71 });
    expect(result).toMatchObject({ rosterEntryId: 71, outcome: "found", xeroWritePermitted: false });
    expect(updateFinancialCandidateRosterDiscovery).toHaveBeenCalledWith(expect.objectContaining({ id: 71, discoveryStatus: "found", candidateRecordId: "4x702903" }));
  });

  it("blocks candidate shadow execution when either AP-owned read-only integration is unavailable", async () => {
    const { appRouter } = await import("./routers");
    const { testVtigerFinancialConnection } = await import("./vtigerFinancialReadService");
    const { createFinancialIntegrationAudit, getFinancialCandidateRosterEntry } = await import("./financialWorkflowDb");
    vi.mocked(getFinancialCandidateRosterEntry).mockResolvedValueOnce({
      id: 71, sourceCategory: "deal", businessNumber: "D702903", workflowType: "main_customer_invoice", branch: "Main invoice", discoveryStatus: "found", candidateRecordId: "4x702903",
    } as any);
    vi.mocked(testVtigerFinancialConnection).mockResolvedValueOnce({ configured: true, missing: [], outcome: "failed", message: "VTiger access key is invalid", checkedAt: new Date() } as any);
    await expect(appRouter.createCaller(context("admin")).financialOperations.runCandidateShadowTest({
      rosterEntryId: 71, sourceCategory: "deal", businessNumber: "D702903", candidateRecordId: "4x702903", workflowType: "main_customer_invoice", branch: "Main invoice",
    })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(createFinancialIntegrationAudit).toHaveBeenCalledWith(expect.objectContaining({ integration: "vtiger", action: "candidate_test_get_only_readiness", outcome: "failed" }));
  });

  it("allows only an administrator to confirm or reject recorded shadow evidence", async () => {
    const { appRouter } = await import("./routers");
    const { reviewFinancialShadowTest } = await import("./financialWorkflowDb");
    await expect(appRouter.createCaller(context("user")).financialOperations.reviewShadowTest({
      testId: 901, reviewStatus: "confirmed", reviewerComment: "Confirmed against source and rule facts.",
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(appRouter.createCaller(context("admin")).financialOperations.reviewShadowTest({
      testId: 901, reviewStatus: "confirmed", reviewerComment: "Confirmed against source and rule facts.",
    })).resolves.toMatchObject({ success: true, xeroWritePermitted: false });
    expect(reviewFinancialShadowTest).toHaveBeenCalledWith(expect.objectContaining({ testId: 901, reviewedBy: 1, reviewStatus: "confirmed" }));
  });

  it("does not allow a blocked or different test to be confirmed", async () => {
    const { appRouter } = await import("./routers");
    const { getFinancialShadowTestById } = await import("./financialWorkflowDb");
    vi.mocked(getFinancialShadowTestById).mockResolvedValueOnce({ id: 902, reviewStatus: "pending", actualResult: { reviewEligible: false } } as any);
    await expect(appRouter.createCaller(context("admin")).financialOperations.reviewShadowTest({
      testId: 902, reviewStatus: "confirmed", reviewerComment: "Attempting to override a blocked test.",
    })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("prepares a disabled cutover pack only from administrator-confirmed clean shadow evidence", async () => {
    const { appRouter } = await import("./routers");
    const { createDisabledFinancialCutoverPack, getFinancialShadowTestById, getFinancialWorkflowRunDetail } = await import("./financialWorkflowDb");
    vi.mocked(getFinancialShadowTestById).mockResolvedValueOnce({
      id: 901, workflowType: "container_control_acquisition", status: "passed", reviewStatus: "confirmed",
      workflowRunId: 77, sourceRecordNumber: "CC-1860", xeroPreflight: { readOnly: true },
    } as any);
    vi.mocked(getFinancialWorkflowRunDetail).mockResolvedValueOnce({
      run: { id: 77, idempotencyKey: "stable-key" },
      intents: [{ id: 201, documentFamily: "purchase_order", documentType: "initial_for_hire", proposedDocumentNumber: "H1860", total: "132.00", lineItems: [] }],
      exceptions: [],
    } as any);
    const result = await appRouter.createCaller(context("admin")).financialOperations.prepareDisabledCutoverPack({ shadowTestId: 901 });
    expect(result).toMatchObject({ packId: 44, controlId: 55, mode: "live_ready_disabled", xeroWritePermitted: false });
    expect(createDisabledFinancialCutoverPack).toHaveBeenCalledWith(expect.objectContaining({
      shadowTestId: 901, workflowType: "container_control_acquisition", proposedDocumentIntentIds: [201], idempotencyKey: "stable-key",
    }));
  });

  it("rejects cutover pack preparation for unconfirmed or held evidence", async () => {
    const { appRouter } = await import("./routers");
    const { getFinancialShadowTestById } = await import("./financialWorkflowDb");
    vi.mocked(getFinancialShadowTestById).mockResolvedValueOnce({
      id: 902, workflowType: "container_control_acquisition", status: "held", reviewStatus: "pending",
    } as any);
    await expect(appRouter.createCaller(context("admin")).financialOperations.prepareDisabledCutoverPack({ shadowTestId: 902 }))
      .rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("allows only an administrator to prepare an all-family release manifest with no writer enablement", async () => {
    const { appRouter } = await import("./routers");
    const { prepareAllFinancialReleaseManifest } = await import("./financialWorkflowDb");
    await expect(appRouter.createCaller(context("user")).financialOperations.prepareAllFamilyReleaseManifest({}))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(appRouter.createCaller(context("admin")).financialOperations.prepareAllFamilyReleaseManifest({
      maintenanceWindow: "Deferred pending all release gates", releaseOwner: "AP owner",
    })).resolves.toMatchObject({
      mode: "release_preparation_only", xeroWritePermitted: false, schedulesChanged: false, sourceSystemsChanged: false,
    });
    expect(prepareAllFinancialReleaseManifest).toHaveBeenCalledWith(expect.objectContaining({
      preparedBy: 1, maintenanceWindow: "Deferred pending all release gates", releaseOwner: "AP owner",
    }));
  });

  it("records legacy writer inventory locally without an external writer action", async () => {
    const { appRouter } = await import("./routers");
    const { recordFinancialReleaseLegacyInventory } = await import("./financialWorkflowDb");
    const input = {
      manifestId: 88, familyId: 99, legacyWriterIdentifier: "Operations workflow: legacy-hire", legacyWriterOwner: "IT owner",
      legacyDisableAction: "Disable only after the separate release approval is recorded.",
    };
    await expect(appRouter.createCaller(context("user")).financialOperations.recordReleaseLegacyInventory(input))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(appRouter.createCaller(context("admin")).financialOperations.recordReleaseLegacyInventory(input))
      .resolves.toMatchObject({ mode: "release_preparation_only", xeroWritePermitted: false, sourceSystemsChanged: false });
    expect(recordFinancialReleaseLegacyInventory).toHaveBeenCalledWith(expect.objectContaining({ ...input, actorId: 1 }));
  });

});
