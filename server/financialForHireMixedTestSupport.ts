import { MySqlDialect } from "drizzle-orm/mysql-core";
import { financialForHireManualHandovers as openings, financialForHireManualHandoverAudits as audits, financialForHirePoEvents as events } from "../drizzle/schema";
import { buildManualForHireHandoverPlan } from "./financialForHireManualHandoverRules";
import { bindManualForHireMixedHistory, forHireApAnchor } from "./financialForHireMixedAnchor";
import { financialSha256 } from "./financialProposalIntegrity";

export function offlineMixedFixture(withAnchor = true) {
  const facts: any = { recordId: "79x489745", controlNumber: "C1920", acquisition: "FOR HIRE", status: "ON HIRE", containerNumber: "TGHU1234567", containerType: "20 FOOT", collectionDate: "2026-10-16", supplierVtigerId: "18x44", supplierName: "Offline Same Supplier" };
  const evidence: any = { complete: false, tenantId: "offline-tenant", supplierContactId: "offline-contact", relatedPurchaseOrders: [],
    coverageAttestation: { confirmedLatestCoverage: true, confirmedNoOtherFutureCoverage: true, confirmedCoveredThrough: true, coveredThrough: "2026-12-15", reviewedBy: 7 },
    lumpSumManual: { confirmed: true, reviewedBy: 7, lineIndex: 0, amount: 139.5 }, manualPo: { PurchaseOrderID: "offline-manual", PurchaseOrderNumber: "HC1920-1", Status: "BILLED", CurrencyCode: "AUD", LineAmountTypes: "Exclusive", Contact: { ContactID: "offline-contact", Name: "Offline Same Supplier" },
      LineItems: [{ ItemCode: "Hire 20HC", Quantity: 1, UnitAmount: 139.5, AccountCode: "312", TaxType: "INPUT", Description: "TGHU1234567 20' Hire" }] } };
  const ap: any = { id: 120001, containerControlId: facts.recordId, eventKind: "initial", proposedPoNumber: "HC1920", billingPeriodStart: "2026-10-16", billingPeriodEnd: "2026-11-15", status: "drafts_created", processingToken: null, executionId: 100, xeroPurchaseOrderId: "offline-ap", proposal: { untouched: true }, nextBillingDate: "2026-11-16" };
  const base = buildManualForHireHandoverPlan({ facts, evidence, manualPoNumber: "HC1920-1", coveredThrough: "2026-12-15", effectiveFrom: "2026-12-16", now: "2026-11-15" });
  const plan = bindManualForHireMixedHistory(base, withAnchor ? forHireApAnchor(ap) : null, evidence.manualPo.Contact);
  const opening: any = { id: 9, containerControlId: facts.recordId, containerControlNumber: "C1920", manualPoId: plan.manualPoId, manualPoNumber: plan.manualPoNumber, coveredThrough: plan.coveredThrough, nextBillingDate: plan.nextPeriodStart, plan, planHash: plan.planHash, evidence, status: "approved", processingToken: null, firstApEventId: null, approvedBy: 7, manualCreationStopped: true, acknowledgement: "FUTURE_ONLY_MANUAL_PO_HANDOVER" };
  const first: any = { ...ap, id: 120002, eventKind: "recurring", billingPeriodStart: plan.nextPeriodStart, billingPeriodEnd: plan.nextPeriodEnd, proposedPoNumber: plan.nextPoNumber, status: "previewed", processingToken: null, nextBillingDate: null, executionId: null, xeroPurchaseOrderId: null, proposal: { next: true }, authorisedPayload: { manualHandoverId: 9, manualHandoverPlanHash: plan.planHash, priorEventId: plan.priorApAnchor?.id } };
  Object.assign(first, { sourceSnapshotHash: financialSha256(facts), rulesSnapshotHash: "r".repeat(64), xeroPreflight: { offline: true }, xeroPreflightHash: financialSha256({ offline: true }) });
  const input = { plan, evidence, approvedBy: 7, manualCreationStopped: true as const, acknowledgement: "FUTURE_ONLY_MANUAL_PO_HANDOVER" as const };
  return { facts, evidence, ap, plan, opening, first, input };
}

export function offlinePreviewClaim(row: any, extra: Record<string, any> = {}) {
  return { expectedPreview: { containerControlId: row.containerControlId, eventKind: row.eventKind, billingPeriodStart: row.billingPeriodStart,
    billingPeriodEnd: row.billingPeriodEnd, proposedPoNumber: row.proposedPoNumber, sourceSnapshotHash: row.sourceSnapshotHash,
    rulesSnapshotHash: row.rulesSnapshotHash, xeroPreflightHash: row.xeroPreflightHash, proposalHash: financialSha256(row.proposal) }, ...extra };
}

/** No connector or database. A serialized, rollback-capable local model records generated SQL. */
export function offlineDb(initialEvents: any[] = [], initialOpenings: any[] = []) {
  const state = { events: structuredClone(initialEvents), openings: structuredClone(initialOpenings), audits: [] as any[] };
  const log: Array<{ operation: string; table: any; sql?: string; params?: any[]; values?: any }> = [];
  const dialect = new MySqlDialect();
  const rows = (table: any) => table === events ? state.events : table === openings ? state.openings : state.audits;
  function matches(row: any, condition: any) {
    if (!condition) return true;
    const q = dialect.sqlToQuery(condition); let index = 0;
    const checks = Array.from(q.sql.matchAll(/`(\w+)`\s*(= \?|<= \?|> \?|is null|in \([^)]*\))/g));
    return checks.every(match => {
      const field = match[1]; const op = match[2];
      if (op === "is null") return row[field] === null || row[field] === undefined;
      if (op.startsWith("in")) { const count = (op.match(/\?/g) ?? []).length; const allowed = q.params.slice(index, index += count); return allowed.includes(row[field]); }
      const value: any = q.params[index++];
      return op === "= ?" ? row[field] === value : op === "<= ?" ? row[field] != null && row[field] <= value : row[field] > value;
    });
  }
  const api: any = {
    select: () => ({ from: (table: any) => {
      let condition: any; let maximum = Infinity;
      const query: any = {
        where: (c: any) => { condition = c; const q = dialect.sqlToQuery(c); log.push({ operation: "select", table, ...q }); return query; },
        orderBy: () => query,
        limit: (n: number) => { maximum = n; return query; },
        for: (mode: string) => { log.push({ operation: `lock:${mode}`, table }); return query; },
        then: (resolve: any, reject: any) => Promise.resolve(rows(table).filter(row => matches(row, condition)).slice(0, maximum)).then(resolve, reject),
      }; return query;
    } }),
    update: (table: any) => ({ set: (values: any) => ({ where: async (condition: any) => {
      const q = dialect.sqlToQuery(condition); log.push({ operation: "update", table, values: structuredClone(values), ...q });
      let affectedRows = 0;
      for (const row of rows(table)) if (matches(row, condition)) { Object.assign(row, values); affectedRows++; }
      return [{ affectedRows }];
    } }) }),
    insert: (table: any) => ({ values: (values: any) => {
      async function insert(duplicateNoop = false) {
        log.push({ operation: "insert", table, values: structuredClone(values) });
        if (table === openings && state.openings.some(row => row.containerControlId === values.containerControlId || row.manualPoId === values.manualPoId)) throw new Error("duplicate immutable opening");
        if (table === events && state.events.some(row => row.proposedPoNumber === values.proposedPoNumber || (row.containerControlId === values.containerControlId && row.eventKind === values.eventKind && row.billingPeriodStart === values.billingPeriodStart))) {
          if (duplicateNoop) return;
          throw new Error("duplicate immutable event number/period");
        }
        rows(table).push({ id: table === openings ? 9 : table === events ? Math.max(0, ...state.events.map(row => row.id)) + 1 : state.audits.length + 1, processingToken: null, firstApEventId: null, ...values });
      }
      return { then: (resolve: any, reject: any) => insert().then(resolve, reject), onDuplicateKeyUpdate: ({ set }: any) => {
        if (Object.keys(set).join() !== "id") throw new Error("Offline model forbids overwriting duplicate receipt history");
        return insert(true);
      } };
    } }),
  };
  let tail = Promise.resolve();
  api.transaction = (callback: any) => {
    const task = tail.then(async () => {
      const snapshot = structuredClone(state); log.push({ operation: "begin", table: null });
      try { const result = await callback(api); log.push({ operation: "commit", table: null }); return result; }
      catch (error) { Object.assign(state, snapshot); log.push({ operation: "rollback", table: null }); throw error; }
    });
    tail = task.then(() => undefined, () => undefined); return task;
  };
  return { db: api, state, log };
}
