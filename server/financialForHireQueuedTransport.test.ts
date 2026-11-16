import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { financialForHirePoEvents as eventsTable, financialForHireInitialProvenance as provenanceTable, financialForHireManualHandovers as openingsTable, financialWriterExecutions as writersTable } from "../drizzle/schema";
const m = vi.hoisted(() => ({ db: vi.fn(), policy: vi.fn(), auth: vi.fn(), ordinary: vi.fn(), manual: vi.fn(), post: vi.fn(), put: vi.fn(), get: vi.fn(), queue: vi.fn(), report: vi.fn() }));
vi.mock("axios", () => ({ default: { post: m.post, put: m.put, get: m.get } }));
vi.mock("./db", () => ({ getDb: m.db, getXeroToken: async () => null, updateXeroRateLimitState: vi.fn(), getXeroApiCache: vi.fn(), setXeroApiCache: vi.fn(), invalidateXeroApiCache: vi.fn() }));
vi.mock("./financialWorkflowDb", () => ({ getFinancialWorkflowConfig: async () => [{ configKey: "financial-automation.for-hire-release", configValue: await m.policy() }], upsertFinancialWorkflowConfig: vi.fn() }));
vi.mock("./xeroService", () => ({ getXeroReadAuthWithRefresh: m.auth, EXPECTED_AP_XERO_TENANT_LABEL: "Offline tenant" }));
vi.mock("./workflowAlertService", () => ({ reportWorkflowFailureSafely: m.report }));
vi.mock("./financialForHireService", () => ({ verifyCurrentOrdinaryForHireDraft: m.ordinary }));
vi.mock("./financialForHireManualHandoverService", () => ({ verifyManualForHireFirstWrite: m.manual }));
vi.mock("./xeroRequestManager", async original => {
  const actual = await original<typeof import("./xeroRequestManager")>();
  return { ...actual, runXeroRequest: (...args: Parameters<typeof actual.runXeroRequest>) => { m.queue(args[1], args[3]); return actual.runXeroRequest(...args); } };
});
import { buildInitialForHirePo, buildRecurringForHirePo } from "./financialForHireDrafts";
import { financialSha256 } from "./financialProposalIntegrity";
import { forHirePayloadHash, forHirePreviewVersion, verifyForHireQueuedWriteAccess, type ForHireQueuedReservation } from "./financialForHireDb";
import { buildForHireInitialReceiptSnapshot, buildVerifiedForHireFutureChainProof, FOR_HIRE_FUTURE_INITIAL_EVENT_RULES_HASH, FOR_HIRE_FUTURE_INITIAL_ORIGIN } from "./financialForHireFutureEligibility";
import { FOR_HIRE_RULES_HASH, FOR_HIRE_RECURRING_RULES_HASH } from "./financialForHireRelease";
import { executeFinancialDraftWrite, prepareFinancialDraftPayload, type FinancialDraftPayload, type FinancialWriteAuthorisation } from "./financialProductionWriter";
import { runXeroRequest, runBoundedXeroGet } from "./xeroRequestManager";
const dialect = new MySqlDialect();
const facts: any = { recordId: "79x700001", controlNumber: "C2001", acquisition: "FOR HIRE", status: "ON HIRE", containerNumber: "OFFLINE20", containerType: "20 FOOT", collectionDate: "2026-10-01", supplierVtigerId: "18x44", supplierName: "Offline supplier", monthlyCostInclusive: 132 };
const now = new Date("2026-11-16T10:00:00Z");
let sequence = 0;
let tenant: { token: string; tenantId: string };
let policy: any;
let state: { events: any[]; provenance: any[]; writers: any[]; openings: any[] };
let readHook: ((table: unknown, sql: string) => void) | undefined;
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
function dbModel() {
  const rows = (table: unknown) => table === eventsTable ? state.events : table === provenanceTable ? state.provenance : table === writersTable ? state.writers : state.openings;
  function matches(row: any, condition: any) {
    const q = dialect.sqlToQuery(condition); let i = 0;
    if (q.sql.includes("is not null") && q.sql.includes(" or ")) return row.containerControlId === q.params[0] && (!q.sql.includes("<> ?") || row.id !== q.params[1]) && (!!row.processingToken || ["reserved", "reconciliation_required"].includes(row.status));
    return [...q.sql.matchAll(/`(\w+)`\s*(= \?|<> \?|is null|in \([^)]*\))/g)].every(match => {
      const field = match[1], op = match[2];
      if (op === "is null") return row[field] == null;
      if (op.startsWith("in")) { const count = (op.match(/\?/g) ?? []).length; const values = q.params.slice(i, i += count); return values.includes(row[field]); }
      const value = q.params[i++]; return op === "= ?" ? row[field] === value : row[field] !== value;
    });
  }
  m.db.mockResolvedValue({ select: () => ({ from: (table: unknown) => {
    let condition: any; let limit = Infinity; let ordered = false;
    const query: any = {
      where: (value: any) => { condition = value; return query; }, orderBy: () => { ordered = true; return query; }, limit: (value: number) => { limit = value; return query; },
      then: (resolve: any, reject: any) => {
        readHook?.(table, dialect.sqlToQuery(condition).sql);
        let list = rows(table).filter(row => matches(row, condition));
        if (ordered && table === eventsTable) list = [...list].sort((a, b) => b.billingPeriodEnd.localeCompare(a.billingPeriodEnd) || b.id - a.id);
        return Promise.resolve(structuredClone(list.slice(0, limit))).then(resolve, reject);
      },
    }; return query;
  } }) });
}
function eventPayload(kind: "initial" | "recurring", id: number) {
  const built = kind === "initial" ? buildInitialForHirePo(facts) : buildRecurringForHirePo({ facts, priorPeriodEnd: "2026-10-31", lastVerifiedExtensionSuffix: null, purchaseRate: 8, now: "2026-11-16" });
  built.document!.partySourceId = "offline-contact";
  const payload = prepareFinancialDraftPayload(built.document!, `${facts.recordId}:${kind}:${built.periodStart}`);
  (payload.body.PurchaseOrders as any[])[0].CurrencyCode = "AUD";
  const event: any = { id, containerControlId: facts.recordId, containerControlNumber: facts.controlNumber, eventKind: kind, billingPeriodStart: built.periodStart, billingPeriodEnd: built.periodEnd, proposedPoNumber: built.proposedPoNumber, containerNumber: facts.containerNumber, containerType: facts.containerType, supplierVtigerId: facts.supplierVtigerId, supplierName: facts.supplierName, sourceSnapshotHash: financialSha256(facts), rulesSnapshotHash: FOR_HIRE_FUTURE_INITIAL_EVENT_RULES_HASH, xeroPreflight: { offline: true }, xeroPreflightHash: financialSha256({ offline: true }), proposal: JSON.parse(JSON.stringify(built.document)), status: "reserved", processingToken: `token-${id}`, releaseKey: policy.releaseKey, createdAt: new Date("2026-11-16T09:59:55Z") };
  event.authorisedPayload = { hash: forHirePayloadHash(payload), number: payload.documentNumber, bodyHash: financialSha256(payload.body), expectedPreview: forHirePreviewVersion(event), claimToken: event.processingToken };
  return { event, payload };
}
function fixture(kind: "initial" | "recurring" = "recurring", branch: "future" | "explicit" | "manual" = "future") {
  const { event, payload } = eventPayload(kind, kind === "initial" ? 1 : 2);
  if (kind === "recurring" && branch === "future") {
    const root = eventPayload("initial", 1); root.event.status = "drafts_created"; root.event.processingToken = null; root.event.executionId = 100; root.event.xeroPurchaseOrderId = "offline-root";
    const po = (root.payload.body.PurchaseOrders as any[])[0];
    const writer: any = { id: 100, workflowType: "initial_for_hire", documentFamily: "purchase_order", proposedAction: "create_draft", proposedDocumentNumber: root.payload.documentNumber, targetXeroDocumentId: null, endpoint: "/PurchaseOrders", method: "POST", idempotencyKey: root.payload.idempotencyKey, payloadFingerprint: `${root.payload.idempotencyKey.slice(0, 24)}:POST:/PurchaseOrders`, status: "succeeded", approvalReference: policy.releaseKey, preparedBy: 7, xeroDocumentId: "offline-root", xeroDocumentStatus: "DRAFT", errorMessage: null, safePayloadSummary: { documentFamily: "purchase_order", documentNumber: root.payload.documentNumber, method: "POST", endpoint: "/PurchaseOrders", targetXeroDocumentId: null, lineCount: po.LineItems.length, lineAmountTypes: po.LineAmountTypes, reference: po.Reference ?? null }, xeroResponseSummary: { documentNumber: root.payload.documentNumber, endpoint: "/PurchaseOrders", idempotencyKey: root.payload.idempotencyKey }, createdAt: new Date("2026-11-16T09:59:56Z"), submittedAt: new Date("2026-11-16T09:59:57Z"), completedAt: new Date("2026-11-16T09:59:58Z") };
    const receipt = buildForHireInitialReceiptSnapshot(root.event);
    const provenance = { containerControlId: facts.recordId, initialEventId: 1, origin: FOR_HIRE_FUTURE_INITIAL_ORIGIN, initialCreatedAt: root.event.createdAt, initialWriterExecutionId: 100, initialXeroPurchaseOrderId: "offline-root", initialReleaseKey: policy.releaseKey, initialRulesHash: root.event.rulesSnapshotHash, initialSourceSnapshotHash: root.event.sourceSnapshotHash, initialReceiptHash: financialSha256(receipt), initialReceipt: receipt, recordedAt: now };
    state.events.push(root.event); state.writers.push(writer); state.provenance.push(provenance);
    event.authorisedPayload.priorEventId = 1;
    event.authorisedPayload.futureProofHash = financialSha256(buildVerifiedForHireFutureChainProof({ provenance, events: [root.event], writers: [writer], priorEventId: 1, currentEvent: event }));
  } else if (kind === "recurring") policy.recurringControlIds = [facts.recordId];
  if (branch === "manual") {
    vi.stubEnv("FINANCIAL_FOR_HIRE_MANUAL_HANDOVER_ENABLED", "true");
    const unsigned = { mixedHistoryVersion: "manual-ap-mixed/v1", priorApAnchor: null, containerControlId: facts.recordId, containerControlNumber: facts.controlNumber, nextPeriodStart: event.billingPeriodStart, nextPeriodEnd: event.billingPeriodEnd, nextPoNumber: event.proposedPoNumber };
    const plan = { ...unsigned, planHash: financialSha256(unsigned) };
    state.openings.push({ id: 9, containerControlId: facts.recordId, status: "reserved", processingToken: event.processingToken, firstApEventId: event.id, planHash: plan.planHash, plan, manualCreationStopped: true, acknowledgement: "FUTURE_ONLY_MANUAL_PO_HANDOVER", approvedBy: 7 });
    event.authorisedPayload.manualHandoverId = 9; event.authorisedPayload.manualHandoverPlanHash = plan.planHash;
  }
  state.events.push(event);
  const context: FinancialWriteAuthorisation = { executionId: 501, workflowType: kind === "initial" ? "initial_for_hire" : "recurring_for_hire", approvalReference: policy.releaseKey, globalShadowMode: false, familyLiveEnabled: true, releaseManifestApproved: true, cutoverPackApproved: true, currentDocumentPreflightPassed: true, legacyWriterHandoffComplete: true, forHireAutomaticEventId: event.id, forHireReleaseKey: policy.releaseKey, forHireApprovedBy: 7 };
  const reservation: ForHireQueuedReservation = { claimToken: event.processingToken, authorisationHash: financialSha256(event.authorisedPayload), preview: forHirePreviewVersion(event) };
  return { event, payload, context, reservation };
}
async function pausedWrite(f: ReturnType<typeof fixture>, wait: "auth" | "fifo") {
  const entered = deferred(), release = deferred();
  let blocker: Promise<unknown> | undefined;
  if (wait === "auth") m.auth.mockImplementation(async () => { entered.resolve(); await release.promise; return tenant; });
  else {
    blocker = runXeroRequest(tenant, "offline FIFO blocker", async () => { entered.resolve(); await release.promise; return { data: {}, headers: {}, status: 200 } as any; });
    await entered.promise;
  }
  const queued = deferred();
  m.queue.mockImplementation((name: string) => { if (name.startsWith("POST financial-draft:")) queued.resolve(); });
  const completed = executeFinancialDraftWrite(f.payload, f.context).then(result => ({ result, error: undefined }), error => ({ result: undefined, error }));
  await (wait === "auth" ? entered.promise : queued.promise);
  return { completed, resume: async () => { if (wait === "fifo") vi.setSystemTime(new Date(Date.now() + 1200)); release.resolve(); await blocker; } };
}
beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now); vi.stubEnv("FINANCIAL_FOR_HIRE_AUTOMATIC_ENABLED", "true"); vi.stubEnv("FINANCIAL_FOR_HIRE_MANUAL_HANDOVER_ENABLED", "false"); vi.stubEnv("FINANCIAL_LIVE_WRITES_ENABLED", "false");
  state = { events: [], provenance: [], writers: [], openings: [] }; readHook = undefined; tenant = { token: "offline-token", tenantId: `offline-queued-${++sequence}` };
  policy = { releaseKey: "offline-for-hire-release", rulesHash: FOR_HIRE_RULES_HASH, enabled: true, initialEnabled: true, recurringEnabled: true, approvedBy: 7, approvedAt: "2026-10-01T00:00:00Z", effectiveFrom: "2026-10-01T11:00:00+11:00", forHireOnlyVtigerBranch: true, initialOperationsHandoff: true, recurringOperationsHandoff: true, migrationScope: "new_events_only", recurringRulesHash: FOR_HIRE_RECURRING_RULES_HASH, recurringControlIds: [], recurringApprovedAt: "2026-11-16T09:59:00Z", recurringEffectiveFrom: "2026-11-16T09:59:00Z", recurringFutureInitialsEnabled: true, recurringFutureInitialsFrom: "2026-11-16T09:59:00Z", recurringFutureExcludedControlIds: ["79x17"] };
  dbModel(); m.policy.mockImplementation(async () => structuredClone(policy)); m.auth.mockResolvedValue(tenant); m.ordinary.mockResolvedValue(undefined); m.manual.mockResolvedValue(undefined);
  m.post.mockImplementation(async (_url, body) => ({ data: { PurchaseOrders: [{ ...body.PurchaseOrders[0], PurchaseOrderID: "offline-created" }] }, headers: {} }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("For Hire immediate queued POST guard (offline, real tenant FIFO)", () => {
  for (const wait of ["auth", "fifo"] as const) {
    it.each(["future disabled", "future excluded", "reservation reconciled", "replacement token", "policy disabled", "release changed", "preview changed", "preflight changed", "body changed", "ancestor writer changed", "future proof changed", "future proof removed", "new manual overlay"])(`blocks %s after ${wait} waiting with zero POST`, async change => {
      const f = fixture(); const paused = await pausedWrite(f, wait);
      if (change === "future disabled") policy.recurringFutureInitialsEnabled = false;
      if (change === "future excluded") policy.recurringFutureExcludedControlIds.push(facts.recordId);
      if (change === "reservation reconciled") { f.event.status = "reconciliation_required"; f.event.processingToken = null; }
      if (change === "replacement token") { f.event.processingToken = "replacement"; f.event.authorisedPayload.claimToken = "replacement"; }
      if (change === "policy disabled") policy.recurringEnabled = false;
      if (change === "release changed") policy.releaseKey = "replacement";
      if (change === "preview changed") f.event.proposal.reference = "changed";
      if (change === "preflight changed") f.event.xeroPreflight = { changed: true };
      if (change === "body changed") (f.payload.body.PurchaseOrders as any[])[0].Reference = "changed";
      if (change === "ancestor writer changed") state.writers[0].status = "reconciliation_required";
      if (change === "future proof changed") f.event.authorisedPayload.futureProofHash = "a".repeat(64);
      if (change === "future proof removed") delete f.event.authorisedPayload.futureProofHash;
      if (change === "new manual overlay") state.openings.push({ id: 9, containerControlId: facts.recordId, status: "approved" });
      const before = structuredClone(state); await paused.resume(); const outcome = await paused.completed;
      expect(outcome.error).toBeInstanceOf(Error); expect(m.post).not.toHaveBeenCalled(); expect(m.get).not.toHaveBeenCalled(); expect(m.ordinary).toHaveBeenCalledOnce(); expect(state).toEqual(before);
      expect(m.queue.mock.calls.filter(([name]) => name.startsWith("POST financial-draft:"))).toHaveLength(1);
    });
    it.each(["initial", "recurring"] as const)(`writes an unchanged %s claim exactly once after ${wait} waiting`, async kind => {
      const f = fixture(kind); const paused = await pausedWrite(f, wait); await paused.resume(); const outcome = await paused.completed;
      expect(outcome.error).toBeUndefined(); expect(outcome.result).toMatchObject({ xeroDocumentId: "offline-created", status: "DRAFT" }); expect(m.post).toHaveBeenCalledOnce(); expect(m.get).not.toHaveBeenCalled(); expect(m.ordinary).toHaveBeenCalledOnce();
      expect(m.queue.mock.calls.find(([name]) => name.startsWith("POST financial-draft:"))?.[1]).toEqual({ retryTransientGatewayFailures: false });
    });
  }
  it.each(["status", "id", "token", "first event", "plan hash", "plan body", "gate"])("blocks changed manual opening %s after FIFO waiting", async change => {
    const f = fixture("recurring", "manual"); const paused = await pausedWrite(f, "fifo"); const opening = state.openings[0];
    if (change === "status") opening.status = "reconciliation_required";
    if (change === "id") opening.id = 10;
    if (change === "token") opening.processingToken = "replacement";
    if (change === "first event") opening.firstApEventId = 999;
    if (change === "plan hash") opening.planHash = "a".repeat(64);
    if (change === "plan body") opening.plan.nextPoNumber = "changed";
    if (change === "gate") vi.stubEnv("FINANCIAL_FOR_HIRE_MANUAL_HANDOVER_ENABLED", "false");
    await paused.resume(); expect((await paused.completed).error).toBeInstanceOf(Error); expect(m.post).not.toHaveBeenCalled(); expect(m.manual).toHaveBeenCalledOnce(); expect(m.get).not.toHaveBeenCalled();
  });
  it("writes the exact unchanged reserved manual opening once without another full verifier or GET", async () => {
    const f = fixture("recurring", "manual"); const paused = await pausedWrite(f, "fifo"); await paused.resume(); expect((await paused.completed).error).toBeUndefined(); expect(m.post).toHaveBeenCalledOnce(); expect(m.manual).toHaveBeenCalledOnce(); expect(m.get).not.toHaveBeenCalled();
  });
  it("blocks a last-day recurring reservation crossing Sydney midnight in the FIFO", async () => {
    const f = fixture(); vi.setSystemTime(new Date("2026-11-30T12:59:59.000Z")); const paused = await pausedWrite(f, "fifo");
    vi.setSystemTime(new Date("2026-11-30T13:00:00.000Z")); await paused.resume(); expect((await paused.completed).error?.message).toMatch(/expired/); expect(m.post).not.toHaveBeenCalled(); expect(m.get).not.toHaveBeenCalled();
  });
  it.each(["2026-11-30T12:59:59.000Z", "2026-11-16T10:00:00.000Z"])("accepts the server-owned current recurring period at %s", async date => {
    const f = fixture(); vi.setSystemTime(new Date(date)); await expect(verifyForHireQueuedWriteAccess({ eventId: f.event.id, releaseKey: policy.releaseKey, preparedBy: 7, workflowType: "recurring_for_hire", payload: f.payload, reservation: f.reservation })).resolves.toBeUndefined();
  });
  it("rejects a not-yet-due recurring period without adopting caller now", async () => {
    const f = fixture("recurring", "explicit"); policy.recurringApprovedAt = policy.recurringEffectiveFrom = "2026-10-01T00:00:00Z"; vi.setSystemTime(new Date("2026-10-31T12:59:59Z"));
    await expect(verifyForHireQueuedWriteAccess({ eventId: f.event.id, releaseKey: policy.releaseKey, preparedBy: 7, workflowType: "recurring_for_hire", payload: f.payload, reservation: f.reservation })).rejects.toThrow(/not currently due/);
  });
  it.each(["policy", "reservation", "manual"])("rejects %s changes during the DB-only guard's awaited proof reads", async change => {
    const f = fixture("recurring", change === "manual" ? "manual" : "future"); let changed = false;
    readHook = (table, sql) => {
      if (changed || table !== eventsTable || (change === "manual" ? !sql.includes("containerControlId") : !sql.includes("drafts_created") && !sql.includes("status` = ?"))) return;
      changed = true;
      if (change === "policy") policy.recurringFutureInitialsEnabled = false;
      if (change === "reservation") { f.event.status = "reconciliation_required"; f.event.processingToken = null; }
      if (change === "manual") state.openings[0].status = "reconciliation_required";
    };
    await expect(verifyForHireQueuedWriteAccess({ eventId: f.event.id, releaseKey: policy.releaseKey, preparedBy: 7, workflowType: "recurring_for_hire", payload: f.payload, reservation: f.reservation })).rejects.toThrow(); expect(changed).toBe(true); expect(m.get).not.toHaveBeenCalled();
  });
  it("keeps full direct verification and its queued GET outside the POST FIFO callback", async () => {
    const f = fixture(); m.get.mockResolvedValue({ data: {}, headers: {} });
    m.ordinary.mockImplementation(async () => { await runBoundedXeroGet(tenant, "GET offline-current-proof", "https://api.xero.com/offline-proof"); vi.setSystemTime(new Date(Date.now() + 1200)); });
    await executeFinancialDraftWrite(f.payload, f.context); expect(m.get).toHaveBeenCalledOnce(); expect(m.ordinary).toHaveBeenCalledOnce(); expect(m.post).toHaveBeenCalledOnce(); expect(m.get.mock.invocationCallOrder[0]).toBeLessThan(m.post.mock.invocationCallOrder[0]);
  });
  it("leaves unrelated generic purchase-order behavior and no-retry policy untouched", async () => {
    vi.stubEnv("FINANCIAL_LIVE_WRITES_ENABLED", "true"); vi.stubEnv("FINANCIAL_FOR_HIRE_AUTOMATIC_ENABLED", "false");
    const f = fixture("initial"); const { forHireAutomaticEventId: _id, forHireReleaseKey: _key, forHireApprovedBy: _by, ...generic } = f.context; generic.workflowType = "container_control_acquisition";
    m.db.mockClear(); m.policy.mockClear(); await executeFinancialDraftWrite(f.payload, generic); expect(m.post).toHaveBeenCalledOnce(); expect(m.db).not.toHaveBeenCalled(); expect(m.policy).not.toHaveBeenCalled(); expect(m.ordinary).not.toHaveBeenCalled(); expect(m.queue.mock.calls[0][1]).toEqual({ retryTransientGatewayFailures: false });
  });
});
