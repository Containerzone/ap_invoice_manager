import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { financialForHirePoEvents as events, financialForHireInitialProvenance as provenanceTable, financialForHireManualHandovers as openings, financialWriterExecutions as executions } from "../drizzle/schema";
import { buildInitialForHirePo, buildRecurringForHirePo } from "./financialForHireDrafts";
import { financialSha256 } from "./financialProposalIntegrity";
const m = vi.hoisted(() => ({ db: vi.fn(), policy: vi.fn(), initial: vi.fn(), recurring: vi.fn(), execute: vi.fn(), current: vi.fn(), report: vi.fn() }));
vi.mock("./db", () => ({ getDb: m.db }));
vi.mock("./financialWorkflowDb", () => ({ getFinancialWorkflowConfig: async () => [{ configKey: "financial-automation.for-hire-release", configValue: await m.policy() }], upsertFinancialWorkflowConfig: vi.fn() }));
vi.mock("./financialForHireService", () => ({ previewInitialForHirePo: m.initial, previewRecurringForHirePo: m.recurring, verifyCurrentOrdinaryForHireDraft: m.current, FOR_HIRE_FUTURE_WEBHOOK_PATH: "/api/webhooks/vtiger/container-control-for-hire" }));
vi.mock("./financialWriterExecutionService", () => ({ executeGuardedFinancialWriterCommand: m.execute }));
vi.mock("./workflowAlertService", () => ({ reportWorkflowFailureSafely: m.report }));
import { FOR_HIRE_RULES_HASH, FOR_HIRE_RECURRING_RULES_HASH } from "./financialForHireRelease";
import { assertForHireRecurringScopeForControl, AUTHENTICATED_INITIAL_FOR_HIRE_ORIGIN, withForHireInitialServerContext } from "./financialForHireFutureEligibilityDb";
import { recordForHirePreview, dueForHireRecurringRoots, claimForHirePreview, bindForHirePayload, completeForHireDraft, verifyForHireAutomaticWriteAccess, forHirePreviewVersion, forHirePayloadHash } from "./financialForHireDb";
import { processAutomaticInitialForHire, processAutomaticRecurringForHire, processAutomaticManualForHireOpening } from "./financialForHireLiveService";
import { prepareFinancialDraftPayload } from "./financialProductionWriter";
import { buildForHireInitialReceiptSnapshot, FOR_HIRE_FUTURE_INITIAL_EVENT_RULES_HASH } from "./financialForHireFutureEligibility";
const dialect = new MySqlDialect();
const now = new Date("2026-11-16T10:00:00.000Z");
const facts: any = { recordId: "79x700001", controlNumber: "C2001", acquisition: "FOR HIRE", status: "ON HIRE", containerNumber: "OFFLINE20", containerType: "20 FOOT", collectionDate: "2026-10-01", supplierVtigerId: "18x44", supplierName: "Offline supplier", monthlyCostInclusive: 132 };
let policy: any;
let state: { events: any[]; provenance: any[]; writers: any[]; openings: any[] };
let log: any[];
function dbModel() {
  state = { events: [], provenance: [], writers: [], openings: [] }; log = [];
  const rows = (table: any) => table === events ? state.events : table === provenanceTable ? state.provenance : table === executions ? state.writers : state.openings;
  function matches(row: any, condition: any) {
    const q = dialect.sqlToQuery(condition); let i = 0;
    if (q.sql.includes("is not null") && q.sql.includes(" or ") && q.sql.includes("reconciliation_required") === false) return row.containerControlId === q.params[0] && (q.sql.includes("<> ?") ? row.id !== q.params[1] : true) && (!!row.processingToken || ["reserved", "reconciliation_required"].includes(row.status));
    if (q.sql.includes("is not null") && q.sql.includes(" or ")) return row.containerControlId === q.params[0] && (!!row.processingToken || ["reserved", "reconciliation_required"].includes(row.status));
    const checks = [...q.sql.matchAll(/`(\w+)`\s*(= \?|<> \?|is null|in \([^)]*\))/g)];
    const results = checks.map(match => {
      const field = match[1], op = match[2];
      if (op === "is null") return row[field] == null;
      if (op.startsWith("in")) { const count = (op.match(/\?/g) ?? []).length; const allowed = q.params.slice(i, i += count); return allowed.includes(row[field]); }
      const value = q.params[i++]; return op === "= ?" ? row[field] === value : row[field] !== value;
    });
    return q.sql.includes(" or ") ? results.some(Boolean) : results.every(Boolean);
  }
  const db: any = {
    select: () => ({ from: (table: any) => { let condition: any; let limit = Infinity; let ordered = false; const query: any = {
      where: (value: any) => { condition = value; log.push({ operation: "select", table, ...dialect.sqlToQuery(value) }); return query; },
      orderBy: () => { ordered = true; return query; }, limit: (value: number) => { limit = value; return query; }, for: () => query,
      then: (resolve: any, reject: any) => { let list = rows(table).filter(row => matches(row, condition)); if (ordered && table === events) list = [...list].sort((a, b) => String(b.billingPeriodEnd).localeCompare(String(a.billingPeriodEnd)) || b.id - a.id); return Promise.resolve(list.slice(0, limit)).then(resolve, reject); },
    }; return query; } }),
    update: (table: any) => ({ set: (values: any) => ({ where: async (condition: any) => { let affectedRows = 0; for (const row of rows(table)) if (matches(row, condition)) { Object.assign(row, values); affectedRows++; } log.push({ operation: "update", table, values }); return [{ affectedRows }]; } }) }),
    insert: (table: any) => ({ values: (values: any) => { async function insert(noop = false) {
      if (table === provenanceTable && state.provenance.some(row => row.containerControlId === values.containerControlId || row.initialEventId === values.initialEventId)) throw new Error("immutable provenance collision");
      if (table === events && state.events.some(row => row.proposedPoNumber === values.proposedPoNumber || row.containerControlId === values.containerControlId && row.eventKind === values.eventKind && row.billingPeriodStart === values.billingPeriodStart)) { if (noop) return; throw new Error("duplicate event"); }
      rows(table).push({ id: Math.max(0, ...rows(table).map(row => row.id)) + 1, processingToken: null, createdAt: new Date(now.getTime() - 5000), recordedAt: now, ...values }); log.push({ operation: "insert", table, values });
    } return { then: (resolve: any, reject: any) => insert().then(resolve, reject), onDuplicateKeyUpdate: () => insert(true) }; } }),
    transaction: async (callback: any) => { const before = structuredClone(state); try { const value = await callback(db); log.push({ operation: "commit" }); return value; } catch (error) { state = before; log.push({ operation: "rollback" }); throw error; } },
  }; m.db.mockResolvedValue(db); return db;
}
function preview(kind: "initial" | "recurring") {
  const built = kind === "initial" ? buildInitialForHirePo(facts) : buildRecurringForHirePo({ facts, priorPeriodEnd: "2026-10-31", lastVerifiedExtensionSuffix: null, purchaseRate: 8, now: "2026-11-16" });
  built.document!.partySourceId = "offline-contact";
  return { kind, state: "previewed", holdReason: null, noWrites: true, preview: built, sourceSnapshotHash: financialSha256(facts), rulesSnapshotHash: FOR_HIRE_FUTURE_INITIAL_EVENT_RULES_HASH, xeroPreflightHash: financialSha256({ offline: true }), preflight: { offline: true } };
}
async function persist(kind: "initial" | "recurring") {
  const value = preview(kind);
  await recordForHirePreview({ containerControlId: facts.recordId, containerControlNumber: facts.controlNumber, eventKind: kind, billingPeriodStart: value.preview.periodStart!, billingPeriodEnd: value.preview.periodEnd!, proposedPoNumber: value.preview.proposedPoNumber!, containerNumber: facts.containerNumber, containerType: facts.containerType, supplierVtigerId: facts.supplierVtigerId, supplierName: facts.supplierName, sourceRefreshedAt: null, sourceSnapshotHash: value.sourceSnapshotHash, rulesSnapshotHash: value.rulesSnapshotHash, xeroPreflightHash: value.xeroPreflightHash, proposal: value.preview.document, xeroPreflight: value.preflight, status: "previewed", holdReason: null });
  return value;
}
function writer(command: any, id = 100) {
  const payload = command.payload, po = payload.body.PurchaseOrders[0];
  return { id, workflowType: command.workflowType, documentFamily: "purchase_order", proposedAction: "create_draft", proposedDocumentNumber: payload.documentNumber, targetXeroDocumentId: null, endpoint: "/PurchaseOrders", method: "POST", idempotencyKey: payload.idempotencyKey, payloadFingerprint: `${payload.idempotencyKey.slice(0, 24)}:POST:/PurchaseOrders`, status: "succeeded", approvalReference: policy.releaseKey, preparedBy: 7, xeroDocumentId: `offline-po-${id}`, xeroDocumentStatus: "DRAFT", errorMessage: null, safePayloadSummary: { documentFamily: "purchase_order", documentNumber: payload.documentNumber, method: "POST", endpoint: "/PurchaseOrders", targetXeroDocumentId: null, lineCount: po.LineItems.length, lineAmountTypes: po.LineAmountTypes, reference: po.Reference ?? null }, xeroResponseSummary: { documentNumber: payload.documentNumber, endpoint: "/PurchaseOrders", idempotencyKey: payload.idempotencyKey }, createdAt: new Date(now.getTime() - 4000), submittedAt: new Date(now.getTime() - 3000), completedAt: new Date(now.getTime() - 2000) };
}
const context = () => ({ origin: AUTHENTICATED_INITIAL_FOR_HIRE_ORIGIN, receivedAt: new Date(now.getTime() - 6000) });
async function newInitial() { return processAutomaticInitialForHire(facts.recordId, context()); }
beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers(); vi.setSystemTime(now); vi.stubEnv("FINANCIAL_FOR_HIRE_AUTOMATIC_ENABLED", "true"); vi.stubEnv("FINANCIAL_FOR_HIRE_MANUAL_HANDOVER_ENABLED", "false");
  policy = { releaseKey: "offline-initial-release", rulesHash: FOR_HIRE_RULES_HASH, enabled: true, initialEnabled: true, recurringEnabled: true, approvedBy: 7, approvedAt: "2026-10-01T00:00:00Z", effectiveFrom: "2026-10-01T00:00:00Z", forHireOnlyVtigerBranch: true, initialOperationsHandoff: true, recurringOperationsHandoff: true, migrationScope: "new_events_only", recurringRulesHash: FOR_HIRE_RECURRING_RULES_HASH, recurringControlIds: [], recurringApprovedAt: "2026-11-16T09:59:00Z", recurringEffectiveFrom: "2026-11-16T09:59:00Z", recurringFutureInitialsEnabled: true, recurringFutureInitialsFrom: "2026-11-16T09:59:00Z", recurringFutureExcludedControlIds: ["79x17"] };
  dbModel(); m.policy.mockImplementation(async () => structuredClone(policy)); m.initial.mockImplementation(() => persist("initial")); m.recurring.mockImplementation(() => persist("recurring")); m.current.mockResolvedValue(undefined);
  m.execute.mockImplementation(async command => { const row = writer(command, 100 + state.writers.length); state.writers.push(row); return { outcome: "succeeded", executionId: row.id, result: { xeroDocumentId: row.xeroDocumentId, documentNumber: command.payload.documentNumber, status: "DRAFT" } }; });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("authenticated new initial provenance and immutable future chain", () => {
  it("atomically records new authenticated successful initial metadata even while future recurring is off", async () => {
    policy.recurringFutureInitialsEnabled = false;
    expect(await newInitial()).toMatchObject({ status: "drafts_created", xeroWritesAttempted: 1 });
    expect(state.provenance).toHaveLength(1); expect(state.provenance[0]).toMatchObject({ initialEventId: 1, initialWriterExecutionId: 100, origin: AUTHENTICATED_INITIAL_FOR_HIRE_ORIGIN, initialReleaseKey: policy.releaseKey });
    expect(state.provenance[0].initialReceiptHash).toBe(financialSha256(buildForHireInitialReceiptSnapshot(state.events[0])));
    const event = state.events[0]; const hash = state.provenance[0].initialReceiptHash; event.nextBillingDate = null; event.updatedAt = new Date("2027-01-01");
    expect(financialSha256(buildForHireInitialReceiptSnapshot(event))).toBe(hash);
  });
  it("one-argument initial writes remain unaffected but cannot create future provenance", async () => {
    expect(await processAutomaticInitialForHire(facts.recordId)).toMatchObject({ status: "drafts_created" }); expect(state.provenance).toEqual([]);
  });
  it("old preview and duplicate replay cannot be backfilled by an authenticated callback", async () => {
    await persist("initial"); expect(await newInitial()).toMatchObject({ status: "drafts_created" }); expect(state.provenance).toEqual([]);
    expect(await newInitial()).toMatchObject({ status: "duplicate_replay", xeroWritesAttempted: 0 }); expect(state.provenance).toEqual([]); expect(m.execute).toHaveBeenCalledOnce();
  });
  it.each(["uncertain", "duplicate", "badWriter", "collision"])("does not enroll or retry %s initial outcomes", async kind => {
    if (kind === "uncertain") m.execute.mockResolvedValue({ outcome: "reconciliation_required", executionId: 100 });
    if (kind === "duplicate") m.execute.mockResolvedValue({ outcome: "duplicate", executionId: 100 });
    if (kind === "badWriter") m.execute.mockImplementation(async command => { const row = writer(command); row.xeroDocumentId = "wrong"; state.writers.push(row); return { outcome: "succeeded", executionId: 100, result: { xeroDocumentId: "offline-po-100", documentNumber: command.payload.documentNumber } }; });
    if (kind === "collision") state.provenance.push({ id: 99, containerControlId: facts.recordId, initialEventId: 99 });
    if (["collision", "badWriter"].includes(kind)) await expect(newInitial()).rejects.toThrow(); else expect(await newInitial()).toMatchObject({ status: "reconciliation_required" });
    expect(state.events[0].status).toBe("reconciliation_required"); expect(state.provenance).toHaveLength(kind === "collision" ? 1 : 0); expect(m.execute).toHaveBeenCalledOnce();
  });
  it("proves an initial then its exact -2 recurring descendant without enrolling old controls", async () => {
    await newInitial(); expect(await assertForHireRecurringScopeForControl(policy, facts.recordId, 1)).toMatchObject({ branch: "future" });
    expect(await processAutomaticRecurringForHire(facts.recordId, 1, "2026-11-16")).toMatchObject({ status: "drafts_created", poNumber: "HC2001-2" });
    expect(state.provenance).toHaveLength(1); expect(state.events[1].authorisedPayload).toMatchObject({ priorEventId: 1, futureProofHash: expect.any(String) });
    expect(await assertForHireRecurringScopeForControl(policy, facts.recordId, 2)).toMatchObject({ branch: "future", proof: { ancestryEventIds: [2, 1] } });
    expect(state.events[0].nextBillingDate).toBeNull();
  });
  it.each(["cutoff", "exclusion", "receipt", "source", "writer", "disconnected", "uncertain", "overlay", "prior"])("rejects %s before recurring preview or transport", async kind => {
    await newInitial(); m.recurring.mockClear(); m.execute.mockClear();
    if (kind === "cutoff") policy.recurringFutureInitialsFrom = now.toISOString();
    if (kind === "exclusion") policy.recurringFutureExcludedControlIds.push(facts.recordId);
    if (kind === "receipt") state.provenance[0].initialReceiptHash = "a".repeat(64);
    if (kind === "source") state.events[0].sourceSnapshotHash = "a".repeat(64);
    if (kind === "writer") state.writers[0].status = "reconciliation_required";
    if (kind === "disconnected") state.events.push({ ...state.events[0], id: 50, billingPeriodEnd: "2026-09-01" });
    if (kind === "uncertain") state.events.push({ ...state.events[0], id: 50, status: "reconciliation_required" });
    if (kind === "overlay") state.openings.push({ id: 9, containerControlId: facts.recordId, status: "completed" });
    await expect(processAutomaticRecurringForHire(facts.recordId, kind === "prior" ? 999 : 1, "2026-11-16")).rejects.toThrow();
    expect(m.recurring).not.toHaveBeenCalled(); expect(m.execute).not.toHaveBeenCalled();
  });
  it("manual opening remains explicit-only and exclusions do not block a later exact reviewed ID", async () => {
    await newInitial(); vi.stubEnv("FINANCIAL_FOR_HIRE_MANUAL_HANDOVER_ENABLED", "true");
    await expect(processAutomaticManualForHireOpening(facts.recordId, 9)).rejects.toThrow(); expect(m.recurring).not.toHaveBeenCalled();
    policy.recurringControlIds = [facts.recordId]; policy.recurringFutureExcludedControlIds.push(facts.recordId); m.db.mockClear();
    expect(await assertForHireRecurringScopeForControl(policy, facts.recordId)).toEqual({ branch: "explicit" }); expect(m.db).not.toHaveBeenCalled();
  });
});

describe("future selector and final transport scope revocation", () => {
  it("empty exact IDs with future disabled returns without a DB read", async () => {
    policy.recurringFutureInitialsEnabled = false; m.db.mockClear(); expect(await dueForHireRecurringRoots("2026-11-16", 10, 0, policy)).toEqual([]); expect(m.db).not.toHaveBeenCalled();
  });
  it("bounds selection and combines explicit IDs OR immutable future cutoff and exclusions in SQL", async () => {
    const where = vi.fn(); const limit = vi.fn(async () => []); where.mockReturnValue({ orderBy: () => ({ limit }) }); m.db.mockResolvedValue({ select: () => ({ from: () => ({ where }) }) });
    policy.recurringControlIds = ["79x42"]; await dueForHireRecurringRoots("2026-11-16", 99, 500, policy);
    const q = dialect.sqlToQuery(where.mock.calls[0][0]); expect(q.sql).toContain("EXISTS"); expect(q.sql).toContain("financial_for_hire_initial_provenance"); expect(q.sql).toContain("initialCreatedAt"); expect(q.sql).toContain("NOT IN"); expect(q.sql).toContain(" or "); expect(q.params).toContain("79x42"); expect(q.params).toContain("79x17"); expect(limit).toHaveBeenCalledWith(10);
  });
  it("rejects revoked future scope after paused current-source reads, preserving exact reservation", async () => {
    await newInitial(); const built = await persist("recurring"); const event = state.events[1]; const expectedPreview = forHirePreviewVersion(event);
    const scope = await assertForHireRecurringScopeForControl(policy, facts.recordId, 1, { currentEvent: event }); expect(scope.branch).toBe("future"); const futureProofHash = (scope as any).proofHash;
    expect(await claimForHirePreview(event.id, "token", { expectedPreview, priorEventId: 1, futureProofHash })).toBe(true);
    const payload = prepareFinancialDraftPayload(built.preview.document!, `${facts.recordId}:recurring:${built.preview.periodStart}`); (payload.body.PurchaseOrders as any[])[0].CurrencyCode = "AUD";
    await bindForHirePayload(event.id, policy.releaseKey, payload, { token: "token", expectedPreview, preparedDocument: built.preview.document!, futureProofHash }, undefined, 1);
    let resume!: () => void; let entered!: () => void; const paused = new Promise<void>(resolve => { entered = resolve; }); m.current.mockImplementation(async () => { entered(); await new Promise<void>(resolve => { resume = resolve; }); });
    const before = structuredClone(state.events); const checking = verifyForHireAutomaticWriteAccess({ eventId: event.id, releaseKey: policy.releaseKey, payload, workflowType: "recurring_for_hire", preparedBy: 7 }); await paused; policy.recurringFutureInitialsEnabled = false; resume();
    await expect(checking).rejects.toThrow(/scope|authority|scoped release/); expect(state.events).toEqual(before); expect(m.execute).toHaveBeenCalledOnce();
  });
  it("direct claim cannot bypass missing provenance even with an otherwise valid preview", async () => {
    await persist("recurring"); const event = state.events[0];
    const claimed = await claimForHirePreview(event.id, "token", { expectedPreview: forHirePreviewVersion(event), priorEventId: 99 }).catch(() => false);
    expect(claimed).toBe(false); expect(event.status).toBe("previewed"); expect(m.execute).not.toHaveBeenCalled();
  });
});
