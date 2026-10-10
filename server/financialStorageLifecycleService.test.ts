import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./vtigerFinancialReadService", () => ({
  retrieveCurrentVtigerFinancialRecord: vi.fn(),
}));
vi.mock("./financialStorageLifecycleDb", () => ({
  activeStorageRoots: vi.fn(),
  bindStoragePayloads: vi.fn(),
  claimStorageRoot: vi.fn(),
  patchStoragePeriod: vi.fn(),
  releaseStorageRoot: vi.fn(),
  reserveStoragePeriod: vi.fn(),
  storagePriorExecution: vi.fn(),
  storagePeriods: vi.fn(),
}));
vi.mock("./financialInitialStorageDb", () => ({
  storedStorageReceipts: vi.fn((event: any) => Array.isArray(event.documentResults) ? event.documentResults : []),
  claimInitialStorageEvent: vi.fn(),
  updateInitialStorageEvent: vi.fn(),
}));
vi.mock("./financialReadOnlyXeroService", () => ({
  preflightFinancialXeroIntents: vi.fn(),
  readBackFinancialDraft: vi.fn(),
  verifyInitialStorageXeroAccounts: vi.fn(),
}));
vi.mock("./financialWriterExecutionService", () => ({
  executeGuardedFinancialWriterCommand: vi.fn(),
}));
vi.mock("./financialWorkflowDb", () => ({
  createFinancialPostSuccessAction: vi.fn(),
}));
vi.mock("./vtigerFinancialWriteService", () => ({
  isFinancialPostSuccessVtigerWriteEnabled: vi.fn(() => false),
  runFinancialPostSuccessAction: vi.fn(),
}));
// Keep the production resolver/assertion active. Only the policy lookup is a mock.
vi.mock("./financialStorageRelease", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./financialStorageRelease")>();
  return { ...actual, getStorageReleasePolicy: vi.fn() };
});

import {
  previewStorageFinalisation,
  processAutomaticInitialStorage,
  processRecurringStorageRoot,
  processStorageFinalisation,
  runAutomaticRecurringStorage,
} from "./financialStorageLifecycleService";
import * as initialDb from "./financialInitialStorageDb";
import * as lifecycleDb from "./financialStorageLifecycleDb";
import * as release from "./financialStorageRelease";
import * as workflowDb from "./financialWorkflowDb";
import * as writer from "./financialWriterExecutionService";
import * as vtiger from "./vtigerFinancialReadService";
import * as xero from "./financialReadOnlyXeroService";
import { financialSha256 } from "./financialProposalIntegrity";

const DEAL_ID = "5x900100";
const CONTACT_ID = "4x200";
const DRIVER_ID = "6x300";
const RELEASE_KEY = "STORAGE-UNIT-TEST-RELEASE";

/** All source dates are real passed Sydney business dates; finalisation uses the verified Date Out field. */
const activeDeal = {
  id: DEAL_ID,
  potential_no: "D900100",
  sales_stage: "4 STORAGE at ORIGIN",
  cf_potentials_storagerequired: "Yes at Origin",
  potentialname: "CONT-900100",
  cf_potentials_containertype: "20 Foot Standard",
  cf_potentials_datein: "2026-08-10",
  cf_potentials_fullcontainerdeliverydate: "",
  cf_potentials_dateout: "",
  related_to: "",
  contact_id: CONTACT_ID,
  cf_potentials_contractorc2: DRIVER_ID,
  cf_potentials_fullcontainerdeliveryv: "6x400",
};

function releasedPolicy(overrides: Partial<release.StorageReleasePolicy> = {}): release.StorageReleasePolicy {
  return {
    releaseKey: RELEASE_KEY,
    rulesHash: release.STORAGE_RULES_HASH,
    enabled: true,
    approvedBy: 77,
    approvedAt: "2026-01-05T09:00:00.000Z",
    effectiveFrom: "2026-01-06T00:00:00.000Z",
    handoffs: { activation: true, recurring: true, finalisation: true },
    recoveryEnabled: true,
    ...overrides,
  };
}

function storageEvent(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-08-10T00:00:00.000Z");
  return {
    id: 1,
    dealId: DEAL_ID,
    dealNumber: "D900100",
    location: "origin",
    periodStart: "2026-08-10",
    periodEnd: "2026-08-31",
    suffix: "A",
    eventKind: "initial",
    parentEventId: null,
    nextBillingDate: null,
    finalisedAt: null,
    releaseKey: null,
    authorisedPayloads: null,
    finalisationResults: null,
    finalDate: null,
    processingToken: null,
    sourceHash: "a".repeat(64),
    containerNumber: "CONT-900100",
    containerType: "20 Foot Standard",
    status: "held",
    pilotApprovalKey: null,
    approvedDocumentsHash: null,
    approvedPreflightHash: null,
    approvalExpiresAt: null,
    approvedBy: null,
    legacyHandoffConfirmedAt: null,
    documentResults: [] as any[],
    errorMessage: null,
    retryCount: 0,
    receivedAt: now,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as any;
}

function receipts(numbers: string[]) {
  return numbers.map((number) => ({
    documentType: number.startsWith("INV-") ? "customer_invoice" : number.startsWith("JD") ? "jd_transport" : "gd_storage",
    number,
    xeroId: `existing-${number}`,
    status: "DRAFT" as const,
    readBackAt: "2026-08-11T00:00:00.000Z",
  }));
}

function recoverySourceHash(container = "CONT-900100") {
  return financialSha256({
    dealId: DEAL_ID,
    location: "origin",
    container,
    type: "20 Foot Standard",
    customer: { name: "Contact Bound Customer", vtigerId: CONTACT_ID, email: "contact@example.test" },
    driver: { name: "Origin Driver", vtigerId: DRIVER_ID, email: "driver@example.test" },
    start: "2026-08-10",
    end: "2026-08-15",
  });
}

function passingPreflight(documents: any[], options: { found?: boolean; ids?: Record<string, string>; status?: string } = {}) {
  return documents.map((document, index) => ({
    documentNumber: document.proposedDocumentNumber,
    documentFamily: document.documentFamily,
    duplicateState: options.found ? "found" : "not_found",
    xeroDocumentId: options.ids?.[document.proposedDocumentNumber] ?? null,
    status: options.status ?? (options.found ? "DRAFT" : null),
    partyName: document.partyName,
    contactCheck: { partyName: document.partyName, found: true, count: 1, contactId: `xero-contact-${index + 1}` },
    itemChecks: document.documentType === "jd_transport"
      ? [{ itemCode: document.lineItems[0]?.itemCode, found: true, purchaseUnitPrice: 250, salesUnitPrice: null, nativeDescription: "Exact Xero JD purchase wording" }]
      : [],
    error: null,
  }));
}

let rawDeal: Record<string, unknown>;
let ledger: any[];
let nextEventId: number;
let executionId: number;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("FINANCIAL_STORAGE_AUTOMATIC_ENABLED", "true");
  rawDeal = { ...activeDeal };
  ledger = [];
  nextEventId = 2;
  executionId = 0;

  vi.mocked(release.getStorageReleasePolicy).mockResolvedValue(releasedPolicy());
  vi.mocked(vtiger.retrieveCurrentVtigerFinancialRecord).mockImplementation(async (id) => {
    if (id === DEAL_ID) return rawDeal;
    if (id === CONTACT_ID) return { id, firstname: "Contact", lastname: "Bound Customer", email: "contact@example.test" };
    if (id === DRIVER_ID) return { id, vendorname: "Origin Driver", email: "driver@example.test" };
    throw new Error(`Unexpected mocked VTiger ID ${id}`);
  });

  vi.mocked(lifecycleDb.storagePeriods).mockImplementation(async (dealId, location) =>
    ledger.filter((row) => row.dealId === dealId && (!location || row.location === location)) as any,
  );
  vi.mocked(lifecycleDb.activeStorageRoots).mockImplementation(async () =>
    ledger.filter((row) => !row.parentEventId && !row.finalisedAt && ["drafts_created", "writeback_pending"].includes(row.status)) as any,
  );
  vi.mocked(lifecycleDb.reserveStoragePeriod).mockImplementation(async (input: any, kind: any, parentEventId?: number) => {
    const existing = ledger.find((row) => row.dealId === input.dealId && row.location === input.location && row.periodStart === input.periodStart);
    if (existing) return existing;
    const event = storageEvent({
      id: nextEventId++,
      ...input,
      suffix: ledger.some((row) => row.suffix === "A") ? "B" : "A",
      eventKind: kind,
      parentEventId: parentEventId ?? null,
    });
    ledger.push(event);
    return event;
  });
  vi.mocked(lifecycleDb.claimStorageRoot).mockResolvedValue(true);
  vi.mocked(lifecycleDb.releaseStorageRoot).mockResolvedValue(undefined);
  vi.mocked(lifecycleDb.bindStoragePayloads).mockResolvedValue(undefined);
  vi.mocked(lifecycleDb.storagePriorExecution).mockResolvedValue(null);
  vi.mocked(lifecycleDb.patchStoragePeriod).mockImplementation(async (id, patch: any) => {
    const event = ledger.find((row) => row.id === id);
    if (event) Object.assign(event, patch);
  });

  vi.mocked(initialDb.claimInitialStorageEvent).mockResolvedValue(true);
  vi.mocked(initialDb.updateInitialStorageEvent).mockImplementation(async (input: any) => {
    const event = ledger.find((row) => row.id === input.id);
    if (event) {
      event.status = input.status;
      if (input.receipts) event.documentResults = [...input.receipts];
    }
  });

  vi.mocked(xero.verifyInitialStorageXeroAccounts).mockResolvedValue(undefined);
  vi.mocked(xero.preflightFinancialXeroIntents).mockImplementation(async (documents: any) => passingPreflight(documents));
  vi.mocked(xero.readBackFinancialDraft).mockImplementation(async (input: any) => ({
    documentFamily: input.documentFamily,
    xeroDocumentId: input.expectedXeroDocumentId,
    documentNumber: input.documentNumber,
    status: "DRAFT",
    partyName: null,
    subtotal: null,
    total: null,
    lineCount: 1,
  } as any));
  vi.mocked(writer.executeGuardedFinancialWriterCommand).mockImplementation(async ({ payload }: any) => ({
    outcome: "succeeded",
    executionId: ++executionId,
    result: {
      xeroDocumentId: payload.expectedXeroDocumentId ?? `created-${payload.documentNumber}`,
      documentNumber: payload.documentNumber,
      status: "DRAFT",
      endpoint: payload.endpoint,
      idempotencyKey: payload.idempotencyKey,
    },
  } as any));
  vi.mocked(workflowDb.createFinancialPostSuccessAction).mockResolvedValue({ id: 1 } as any);
});

afterEach(() => vi.unstubAllEnvs());

describe("automatic loaded-storage lifecycle coordinator", () => {
  it("keeps the default deployment gate closed before any CRM, ledger, or writer action", async () => {
    vi.stubEnv("FINANCIAL_STORAGE_AUTOMATIC_ENABLED", "false");

    await expect(processAutomaticInitialStorage(DEAL_ID)).rejects.toThrow(/release is disabled/i);

    expect(vtiger.retrieveCurrentVtigerFinancialRecord).not.toHaveBeenCalled();
    expect(lifecycleDb.reserveStoragePeriod).not.toHaveBeenCalled();
    expect(writer.executeGuardedFinancialWriterCommand).not.toHaveBeenCalled();
  });

  it("creates exactly the current contact-bound AUD initial bundle under the standing release, not a per-event pilot", async () => {
    const result = await processAutomaticInitialStorage(DEAL_ID);

    expect(result).toMatchObject({ ok: true, status: "drafts_created" });
    expect(xero.verifyInitialStorageXeroAccounts).toHaveBeenCalledTimes(1);
    expect(writer.executeGuardedFinancialWriterCommand).toHaveBeenCalledTimes(3);
    const commands = vi.mocked(writer.executeGuardedFinancialWriterCommand).mock.calls.map(([command]) => command as any);
    expect(commands.map((command) => command.payload.documentNumber)).toEqual(["INV-900100-A", "JD900100", "GD900100"]);
    expect(commands.map((command) => command.payload.body.Invoices?.[0]?.CurrencyCode ?? command.payload.body.PurchaseOrders?.[0]?.CurrencyCode)).toEqual(["AUD", "AUD", "AUD"]);
    expect(commands.map((command) => command.payload.body.Invoices?.[0]?.Contact?.ContactID ?? command.payload.body.PurchaseOrders?.[0]?.Contact?.ContactID)).toEqual([
      "xero-contact-1", "xero-contact-2", "xero-contact-3",
    ]);
    for (const command of commands) {
      expect(command.preparedBy).toBe(77);
      expect(command.authorisation).toMatchObject({
        workflowType: "storage_activation",
        storageAutomaticEventId: 2,
        storageReleaseKey: RELEASE_KEY,
        storageApprovedBy: 77,
      });
      expect(command.authorisation.storagePilotEventId).toBeUndefined();
      expect(command.authorisation.storagePilotApprovedBy).toBeUndefined();
    }
    expect(initialDb.claimInitialStorageEvent).toHaveBeenCalledWith(2);
    expect(lifecycleDb.bindStoragePayloads).toHaveBeenCalledWith(2, RELEASE_KEY, expect.any(Array), "storage_activation");
  });

  it("blocks an exact initial-reference collision during preflight before any writer command", async () => {
    vi.mocked(xero.preflightFinancialXeroIntents).mockImplementation(async (documents: any) => {
      const evidence = passingPreflight(documents);
      evidence[0]!.duplicateState = "found";
      evidence[0]!.xeroDocumentId = "collision-invoice";
      evidence[0]!.status = "DELETED";
      return evidence as any;
    });

    await expect(processAutomaticInitialStorage(DEAL_ID)).rejects.toThrow(/occupied/i);

    expect(writer.executeGuardedFinancialWriterCommand).not.toHaveBeenCalled();
    expect(initialDb.claimInitialStorageEvent).not.toHaveBeenCalled();
    expect(lifecycleDb.bindStoragePayloads).not.toHaveBeenCalled();
    expect(lifecycleDb.releaseStorageRoot).toHaveBeenCalledWith(2, expect.any(String));
  });

  it("adopts only a matching release-backed prior Draft execution rather than recreating its exact number", async () => {
    vi.mocked(xero.preflightFinancialXeroIntents).mockImplementation(async (documents: any) => {
      const evidence = passingPreflight(documents);
      evidence[0]!.duplicateState = "found";
      evidence[0]!.xeroDocumentId = "adopted-customer-id";
      evidence[0]!.status = "DRAFT";
      return evidence as any;
    });
    vi.mocked(lifecycleDb.storagePriorExecution).mockImplementation(async payload => ({
      approvalReference: RELEASE_KEY,
      payloadFingerprint: financialSha256(payload.body),
      status: "reconciliation_required",
    } as any));

    await expect(processAutomaticInitialStorage(DEAL_ID)).resolves.toMatchObject({
      ok: true,
      status: "drafts_created",
      documents: ["INV-900100-A", "JD900100", "GD900100"],
    });

    expect(lifecycleDb.storagePriorExecution).toHaveBeenCalledWith(expect.objectContaining({ documentNumber: "INV-900100-A" }));
    expect(xero.readBackFinancialDraft).toHaveBeenCalledWith(expect.objectContaining({
      documentNumber: "INV-900100-A",
      expectedXeroDocumentId: "adopted-customer-id",
    }));
    expect(vi.mocked(writer.executeGuardedFinancialWriterCommand).mock.calls.map(([command]) => (command as any).payload.documentNumber))
      .toEqual(["JD900100", "GD900100"]);
  });

  it("holds an existing incomplete initial event whose persisted source fingerprint no longer matches current VTiger facts", async () => {
    const stale = storageEvent({ id: 3, sourceHash: "b".repeat(64) });
    ledger.push(stale);

    await expect(processAutomaticInitialStorage(DEAL_ID)).rejects.toThrow(/source facts changed since initial reservation/i);

    expect(lifecycleDb.claimStorageRoot).not.toHaveBeenCalled();
    expect(initialDb.claimInitialStorageEvent).not.toHaveBeenCalled();
    expect(writer.executeGuardedFinancialWriterCommand).not.toHaveBeenCalled();
  });

  it("creates exactly two monthly documents, never a second JD transport purchase order", async () => {
    const root = storageEvent({
      id: 10,
      status: "drafts_created",
      periodEnd: "2026-08-31",
      documentResults: receipts(["INV-900100-A", "JD900100", "GD900100"]),
    });
    ledger.push(root);

    const result = await processRecurringStorageRoot(root, "2026-09-01");

    expect(result).toMatchObject({ ok: true, status: "drafts_created", eventId: 2 });
    const commands = vi.mocked(writer.executeGuardedFinancialWriterCommand).mock.calls.map(([command]) => command as any);
    expect(commands).toHaveLength(2);
    expect(commands.map((command) => command.payload.documentNumber)).toEqual(["INV-900100-B", "GD900100-B"]);
    expect(commands.map((command) => command.proposedAction)).toEqual(["create_draft", "create_draft"]);
    expect(commands.map((command) => command.payload.method)).toEqual(["POST", "POST"]);
    expect(commands.map((command) => command.payload.body.Invoices?.[0]?.CurrencyCode ?? command.payload.body.PurchaseOrders?.[0]?.CurrencyCode)).toEqual(["AUD", "AUD"]);
    expect(commands).toEqual(expect.not.arrayContaining([expect.objectContaining({ payload: expect.objectContaining({ documentNumber: expect.stringMatching(/^JD/) }) })]));
    expect(lifecycleDb.claimStorageRoot).toHaveBeenCalledWith(10, expect.any(String));
    expect(lifecycleDb.releaseStorageRoot).toHaveBeenCalledWith(10, expect.any(String));
  });

  it("honours the exclusive monthly-root lock without fetching or writing", async () => {
    const root = storageEvent({ id: 11, status: "drafts_created", documentResults: receipts(["INV-900100-A", "JD900100", "GD900100"]) });
    ledger.push(root);
    vi.mocked(lifecycleDb.claimStorageRoot).mockResolvedValue(false);

    await expect(processRecurringStorageRoot(root, "2026-09-01")).resolves.toEqual({
      ok: false,
      status: "held",
      reason: "Storage location is locked or finalised.",
    });

    expect(vtiger.retrieveCurrentVtigerFinancialRecord).not.toHaveBeenCalled();
    expect(lifecycleDb.reserveStoragePeriod).not.toHaveBeenCalled();
    expect(writer.executeGuardedFinancialWriterCommand).not.toHaveBeenCalled();
  });

  it("bills only on the exact due day: it neither catches up a gap nor recurs after Date Out", async () => {
    const root = storageEvent({
      id: 12,
      status: "drafts_created",
      periodEnd: "2026-08-31",
      documentResults: receipts(["INV-900100-A", "JD900100", "GD900100"]),
    });
    ledger.push(root);

    await expect(processRecurringStorageRoot(root, "2026-08-31")).resolves.toMatchObject({ ok: true, status: "skipped", reason: "Not due." });
    await expect(processRecurringStorageRoot(root, "2026-09-02")).resolves.toMatchObject({ ok: true, status: "skipped", reason: "Billing gap held; no catch-up batch." });
    rawDeal = { ...activeDeal, cf_potentials_dateout: "2026-08-20" };
    await expect(processRecurringStorageRoot(root, "2026-09-01")).resolves.toMatchObject({ ok: true, status: "skipped", reason: expect.stringMatching(/Date Out/) });

    expect(lifecycleDb.reserveStoragePeriod).not.toHaveBeenCalled();
    expect(writer.executeGuardedFinancialWriterCommand).not.toHaveBeenCalled();
  });

  it("skips the scheduler except on the first Sydney calendar day and isolates a held root", async () => {
    await expect(runAutomaticRecurringStorage("2026-09-02")).resolves.toMatchObject({ ok: true, status: "skipped" });
    expect(lifecycleDb.activeStorageRoots).not.toHaveBeenCalled();

    const root = storageEvent({ id: 13, dealNumber: "D900101", status: "drafts_created", documentResults: receipts(["INV-900100-A", "JD900100", "GD900100"]) });
    vi.mocked(lifecycleDb.activeStorageRoots).mockResolvedValue([root] as any);
    vi.mocked(lifecycleDb.claimStorageRoot).mockResolvedValue(false);
    await expect(runAutomaticRecurringStorage("2026-09-01")).resolves.toMatchObject({
      ok: true,
      considered: 1,
      retryRemainingBatch: false,
      results: [{ deal: "D900101", ok: false, status: "held", reason: "Storage location is locked or finalised." }],
    });
  });

  it("finalises exactly the current invoice and GD Draft by their stored immutable IDs, never JD", async () => {
    rawDeal = { ...activeDeal, sales_stage: "11 DELIVER From STORAGE", cf_potentials_dateout: "2026-08-20" };
    const root = storageEvent({
      id: 20,
      status: "drafts_created",
      documentResults: receipts(["INV-900100-A", "JD900100", "GD900100"]),
    });
    ledger.push(root);
    const idByNumber = Object.fromEntries(root.documentResults.map((row: any) => [row.number, row.xeroId]));
    vi.mocked(xero.preflightFinancialXeroIntents).mockImplementation(async (documents: any) => passingPreflight(documents, { found: true, ids: idByNumber }));

    const result = await processStorageFinalisation(DEAL_ID, "origin");

    expect(result).toMatchObject({ ok: true, status: "drafts_created", eventId: 20, documents: ["INV-900100-A", "GD900100"] });
    const commands = vi.mocked(writer.executeGuardedFinancialWriterCommand).mock.calls.map(([command]) => command as any);
    expect(commands).toHaveLength(2);
    expect(commands.map((command) => command.payload.documentNumber)).toEqual(["INV-900100-A", "GD900100"]);
    expect(commands.map((command) => command.proposedAction)).toEqual(["update_draft", "update_draft"]);
    expect(commands.map((command) => command.payload.method)).toEqual(["PUT", "PUT"]);
    expect(commands.map((command) => command.payload.expectedXeroDocumentId)).toEqual([idByNumber["INV-900100-A"], idByNumber.GD900100]);
    expect(commands).toEqual(expect.not.arrayContaining([expect.objectContaining({ payload: expect.objectContaining({ documentNumber: expect.stringMatching(/^JD/) }) })]));
    expect(xero.readBackFinancialDraft).toHaveBeenCalledWith(expect.objectContaining({ documentNumber: "INV-900100-A", expectedXeroDocumentId: idByNumber["INV-900100-A"] }));
    expect(xero.readBackFinancialDraft).toHaveBeenCalledWith(expect.objectContaining({ documentNumber: "GD900100", expectedXeroDocumentId: idByNumber.GD900100 }));
    expect(root.finalisedAt).toBeInstanceOf(Date);
    expect(root.finalDate).toBe("2026-08-20");
  });

  it("holds a non-Draft finalisation target at exact read-back before any update command", async () => {
    rawDeal = { ...activeDeal, sales_stage: "11 DELIVER From STORAGE", cf_potentials_dateout: "2026-08-20" };
    const root = storageEvent({ id: 21, status: "drafts_created", documentResults: receipts(["INV-900100-A", "JD900100", "GD900100"]) });
    ledger.push(root);
    const idByNumber = Object.fromEntries(root.documentResults.map((row: any) => [row.number, row.xeroId]));
    vi.mocked(xero.preflightFinancialXeroIntents).mockImplementation(async (documents: any) => passingPreflight(documents, { found: true, ids: idByNumber, status: "AUTHORISED" }));
    vi.mocked(xero.readBackFinancialDraft).mockRejectedValue(new Error("Xero Draft read-back did not verify the exact expected document INV-900100-A."));

    await expect(processStorageFinalisation(DEAL_ID, "origin")).rejects.toThrow(/read-back/i);

    expect(xero.readBackFinancialDraft).toHaveBeenCalledWith(expect.objectContaining({ expectedXeroDocumentId: idByNumber["INV-900100-A"] }));
    expect(writer.executeGuardedFinancialWriterCommand).not.toHaveBeenCalled();
  });

  it("requires an additional released recovery gate when no storage history exists", async () => {
    rawDeal = { ...activeDeal, sales_stage: "11 DELIVER From STORAGE", cf_potentials_dateout: "2026-08-15" };
    vi.mocked(release.getStorageReleasePolicy).mockResolvedValue(releasedPolicy({ recoveryEnabled: false }));

    await expect(processStorageFinalisation(DEAL_ID, "origin")).rejects.toThrow(/recovery is not released/i);

    expect(lifecycleDb.reserveStoragePeriod).not.toHaveBeenCalled();
    expect(writer.executeGuardedFinancialWriterCommand).not.toHaveBeenCalled();
  });

  it("uses a controlled one-period recovery only when the genuine initial capped period ends on Date Out", async () => {
    rawDeal = { ...activeDeal, sales_stage: "11 DELIVER From STORAGE", cf_potentials_dateout: "2026-08-15" };

    const result = await processStorageFinalisation(DEAL_ID, "origin");

    expect(result).toMatchObject({ ok: true, status: "drafts_created", eventId: 2, documents: ["INV-900100-A", "JD900100", "GD900100"] });
    expect(lifecycleDb.reserveStoragePeriod).toHaveBeenCalledWith(expect.objectContaining({
      dealId: DEAL_ID,
      periodStart: "2026-08-10",
      periodEnd: "2026-08-15",
    }), "recovery");
    const commands = vi.mocked(writer.executeGuardedFinancialWriterCommand).mock.calls.map(([command]) => command as any);
    expect(commands.map((command) => command.payload.documentNumber)).toEqual(["INV-900100-A", "JD900100", "GD900100"]);
    expect(commands.map((command) => command.proposedAction)).toEqual(["create_draft", "create_draft", "create_draft"]);
    expect(commands).toHaveLength(3);
    expect(ledger[0]).toMatchObject({ periodStart: "2026-08-10", periodEnd: "2026-08-15", finalDate: "2026-08-15" });
  });

  it("resumes a partial recovery without recreating its read-back receipt and returns a finalised replay without writes", async () => {
    rawDeal = { ...activeDeal, sales_stage: "11 DELIVER From STORAGE", cf_potentials_dateout: "2026-08-15" };
    const partial = storageEvent({
      id: 30,
      eventKind: "recovery",
      status: "partial",
      periodEnd: "2026-08-15",
      sourceHash: recoverySourceHash(),
      documentResults: receipts(["INV-900100-A"]),
    });
    vi.mocked(lifecycleDb.reserveStoragePeriod).mockImplementation(async () => {
      if (!ledger.includes(partial)) ledger.push(partial);
      return partial;
    });

    await expect(processStorageFinalisation(DEAL_ID, "origin")).resolves.toMatchObject({ ok: true, status: "drafts_created", eventId: 30 });
    const firstRun = vi.mocked(writer.executeGuardedFinancialWriterCommand).mock.calls.map(([command]) => (command as any).payload.documentNumber);
    expect(firstRun).toEqual(["JD900100", "GD900100"]);
    expect(partial.documentResults.map((receipt: any) => receipt.number)).toEqual(["INV-900100-A", "JD900100", "GD900100"]);

    await expect(processStorageFinalisation(DEAL_ID, "origin")).resolves.toEqual({ ok: true, status: "duplicate_replay", eventId: 30 });
    expect(writer.executeGuardedFinancialWriterCommand).toHaveBeenCalledTimes(2);
  });

  it("holds a partial recovery retry when current source facts no longer match its persisted fingerprint", async () => {
    rawDeal = { ...activeDeal, sales_stage: "11 DELIVER From STORAGE", cf_potentials_dateout: "2026-08-15", potentialname: "CONT-CHANGED" };
    const partial = storageEvent({
      id: 31,
      eventKind: "recovery",
      status: "partial",
      periodEnd: "2026-08-15",
      sourceHash: recoverySourceHash(),
      documentResults: receipts(["INV-900100-A"]),
    });
    vi.mocked(lifecycleDb.reserveStoragePeriod).mockResolvedValue(partial);

    await expect(processStorageFinalisation(DEAL_ID, "origin")).rejects.toThrow(/source facts changed/i);

    expect(lifecycleDb.claimStorageRoot).not.toHaveBeenCalled();
    expect(initialDb.claimInitialStorageEvent).not.toHaveBeenCalled();
    expect(writer.executeGuardedFinancialWriterCommand).not.toHaveBeenCalled();
  });

  it("rejects a recovery collision before a writer command, rather than fabricating or suffix-bypassing history", async () => {
    rawDeal = { ...activeDeal, sales_stage: "11 DELIVER From STORAGE", cf_potentials_dateout: "2026-08-15" };
    vi.mocked(xero.preflightFinancialXeroIntents).mockImplementation(async (documents: any) => {
      const evidence = passingPreflight(documents);
      evidence[0]!.duplicateState = "found";
      evidence[0]!.xeroDocumentId = "unowned-history";
      return evidence as any;
    });

    await expect(processStorageFinalisation(DEAL_ID, "origin")).rejects.toThrow(/occupied/i);

    expect(writer.executeGuardedFinancialWriterCommand).not.toHaveBeenCalled();
    expect(lifecycleDb.reserveStoragePeriod).toHaveBeenCalledWith(expect.objectContaining({ periodStart: "2026-08-10", periodEnd: "2026-08-15" }), "recovery");
  });

  it("returns a finalisation reference preview using current read-only evidence without reserving, claiming, patching, or writing", async () => {
    rawDeal = { ...activeDeal, sales_stage: "11 DELIVER From STORAGE", cf_potentials_dateout: "2026-08-15" };
    vi.mocked(xero.preflightFinancialXeroIntents).mockImplementation(async (documents: any) => passingPreflight(documents));

    const result = await previewStorageFinalisation(DEAL_ID, "origin");

    expect(result).toMatchObject({
      dealNumber: "D900100",
      location: "origin",
      dateOut: "2026-08-15",
      referenceOnly: true,
      period: { start: "2026-08-10", end: "2026-08-15", days: 6 },
      documents: [
        { number: "INV-900100-A", xeroState: "not_found" },
        { number: "GD900100", xeroState: "not_found" },
      ],
    });
    expect(lifecycleDb.reserveStoragePeriod).not.toHaveBeenCalled();
    expect(lifecycleDb.claimStorageRoot).not.toHaveBeenCalled();
    expect(initialDb.claimInitialStorageEvent).not.toHaveBeenCalled();
    expect(lifecycleDb.patchStoragePeriod).not.toHaveBeenCalled();
    expect(initialDb.updateInitialStorageEvent).not.toHaveBeenCalled();
    expect(writer.executeGuardedFinancialWriterCommand).not.toHaveBeenCalled();
  });
  it("creates only one genuinely unbilled final month under recovery release, then stops recurrence", async () => {
    rawDeal = { ...activeDeal, sales_stage: "5 CONFIRMED", cf_potentials_dateout: "2026-09-05" };
    const root = storageEvent({ id: 41, status: "drafts_created", documentResults: receipts(["INV-900100-A", "JD900100", "GD900100"]) });
    ledger.push(root);
    const result = await processStorageFinalisation(DEAL_ID, "origin");
    expect(result).toMatchObject({ ok: true, documents: ["INV-900100-B", "GD900100-B"] });
    expect(writer.executeGuardedFinancialWriterCommand).toHaveBeenCalledTimes(2);
    expect(root.finalisedAt).toBeInstanceOf(Date);
    expect(workflowDb.createFinancialPostSuccessAction).toHaveBeenCalledWith(expect.objectContaining({ actionType: "vtiger_task", safePayloadSummary: expect.objectContaining({ taskSubject: "Finalise Storage Invoice", dueDate: "2026-09-05" }) }));
  });
  it("holds missing multiple-month history rather than inventing catch-up billing", async () => {
    rawDeal = { ...activeDeal, cf_potentials_dateout: "2026-10-05" };
    ledger.push(storageEvent({ id: 42, status: "drafts_created", documentResults: receipts(["INV-900100-A", "JD900100", "GD900100"]) }));
    await expect(processStorageFinalisation(DEAL_ID, "origin")).rejects.toThrow(/Multiple unbilled months/);
    expect(writer.executeGuardedFinancialWriterCommand).not.toHaveBeenCalled();
  });
  it("does not silently reopen a finalised location when Date Out changes", async () => {
    rawDeal = { ...activeDeal, cf_potentials_dateout: "2026-08-21" };
    ledger.push(storageEvent({ id: 43, finalisedAt: new Date(), finalDate: "2026-08-20", status: "drafts_created" }));
    await expect(processStorageFinalisation(DEAL_ID, "origin")).rejects.toThrow(/changed after finalisation/);
    expect(writer.executeGuardedFinancialWriterCommand).not.toHaveBeenCalled();
  });
});
