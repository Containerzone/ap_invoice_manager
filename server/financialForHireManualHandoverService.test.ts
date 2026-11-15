import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Temporal } from "@js-temporal/polyfill";
import { buildInitialForHirePo, buildRecurringForHirePo, formatForHireDate, type ForHireContainerControlFacts } from "./financialForHireDrafts";
import { buildManualForHireHandoverPlan, type ManualForHireEvidence } from "./financialForHireManualHandoverRules";
import { offlineMixedFixture } from "./financialForHireMixedTestSupport";
import { bindManualForHireMixedHistory } from "./financialForHireMixedAnchor";
import { financialSha256 } from "./financialProposalIntegrity";
import type { FinancialDraftPayload } from "./financialProductionWriter";

const m = vi.hoisted(() => ({
  source: vi.fn(), events: vi.fn(), existing: vi.fn(), enabled: vi.fn(), evidence: vi.fn(),
  preflight: vi.fn(), approve: vi.fn(), createEvent: vi.fn(), sourceWrite: vi.fn(), xeroWrite: vi.fn(),
}));
vi.mock("./financialForHireService", () => ({ readForHireContainerControl: m.source }));
vi.mock("./financialForHireDb", () => ({ getForHireEventsForControl: m.events, upsertForHireEvent: m.createEvent, createForHireEvent: m.createEvent }));
vi.mock("./financialReadOnlyXeroService", () => ({ readManualForHireHandoverXeroEvidence: m.evidence, preflightFinancialXeroIntents: m.preflight }));
vi.mock("./financialForHireManualHandoverDb", () => ({ isManualForHireHandoverEnabled: m.enabled, getManualForHireHandover: m.existing, approveManualForHireHandover: m.approve }));
// Fail closed if implementation later imports a transport into this read/verify service.
vi.mock("./financialProductionWriter", () => ({
  createFinancialDraft: m.xeroWrite, writeFinancialDraft: m.xeroWrite,
  prepareFinancialDraftPayload: (document: any, key: string) => ({
    method: "POST", endpoint: "/PurchaseOrders", documentFamily: "purchase_order",
    documentNumber: document.proposedDocumentNumber, expectedXeroDocumentId: null, idempotencyKey: key,
    body: { PurchaseOrders: [{ PurchaseOrderID: undefined, PurchaseOrderNumber: document.proposedDocumentNumber,
      Reference: document.reference, Contact: { ContactID: document.partySourceId }, Status: "DRAFT",
      Date: document.issueDate.toISOString().slice(0, 10), LineAmountTypes: "Exclusive",
      LineItems: document.lineItems.map((line: any) => ({ ItemCode: line.itemCode, Description: line.description,
        Quantity: line.quantity, UnitAmount: line.unitAmount, AccountCode: line.accountCode, TaxType: "INPUT" })) }] },
  }),
}));
vi.mock("./vtigerService", () => ({ updateRecord: m.sourceWrite }));
import { enrollManualForHireHandover, previewManualForHireHandover, revalidateManualForHireOpeningPoint, verifyManualForHireFirstWrite } from "./financialForHireManualHandoverService";

function fixture(suffix = 1) {
  const facts: ForHireContainerControlFacts = {
    recordId: "24x1929", controlNumber: "C1929", acquisition: "FOR HIRE", status: "ON HIRE",
    containerNumber: "TGHU1234567", containerType: "40 Foot Standard", collectionDate: "2026-11-13",
    supplierVtigerId: "18x44", supplierName: "Hire Supplier", monthlyCostInclusive: null,
    purchasePriceInclusive: null, liftAndBookingFeesInclusive: null, sourceRefreshedAt: "2026-11-15T00:00:00Z",
  };
  const manual = suffix === 1 ? buildInitialForHirePo(facts) : buildRecurringForHirePo({ facts, priorPeriodEnd: "2026-11-12", lastVerifiedExtensionSuffix: suffix === 2 ? null : suffix - 1, purchaseRate: 16.5, now: "2026-11-13" });
  const input = { recordId: facts.recordId, manualPoNumber: manual.proposedPoNumber!, coveredThrough: manual.periodEnd!, effectiveFrom: Temporal.PlainDate.from(manual.periodEnd!).add({ days: 1 }).toString(), confirmedLatestCoverage: true, confirmedNoOtherFutureCoverage: true, reviewedBy: 7 };
  const raw: ManualForHireEvidence = {
    manualPo: { PurchaseOrderID: "manual-po-id", PurchaseOrderNumber: input.manualPoNumber, Status: "AUTHORISED", CurrencyCode: "AUD", Contact: { ContactID: "contact-44" }, LineAmountTypes: "Exclusive",
      LineItems: manual.document!.lineItems.map(line => ({ ItemCode: line.itemCode, Description: line.description, Quantity: line.quantity, UnitAmount: line.unitAmount, AccountCode: line.accountCode, TaxType: "INPUT" })) },
    relatedPurchaseOrders: [], supplierContactId: "contact-44", tenantId: "tenant-1", complete: false,
  };
  const evidence = { ...raw, coverageAttestation: { confirmedLatestCoverage: true as const, confirmedNoOtherFutureCoverage: true as const, reviewedBy: 7 } };
  const plan = bindManualForHireMixedHistory(buildManualForHireHandoverPlan({ facts, evidence, ...input, now: "2026-11-15" }), null, evidence.manualPo.Contact);
  const row = { id: 9, containerControlId: facts.recordId, containerControlNumber: facts.controlNumber, manualPoId: plan.manualPoId, manualPoNumber: plan.manualPoNumber, coveredThrough: plan.coveredThrough, nextBillingDate: plan.nextPeriodStart, status: "approved", processingToken: null, firstApEventId: null, plan, planHash: plan.planHash, evidence, approvedBy: 7, manualCreationStopped: true, acknowledgement: "FUTURE_ONLY_MANUAL_PO_HANDOVER" };
  const approval = { ...input, expectedPlanHash: plan.planHash, approvedBy: 7, manualCreationStopped: true as const, acknowledgement: "FUTURE_ONLY_MANUAL_PO_HANDOVER" as const };
  return { facts, input, raw, evidence, plan, row, approval };
}
function install(f = fixture()) {
  m.source.mockResolvedValue(f.facts); m.evidence.mockResolvedValue(f.raw);
  m.preflight.mockResolvedValue([{ duplicateState: "not_found", contactCheck: { found: true, contactId: "contact-44" }, itemChecks: [{ found: true, itemCode: "HC 40 E", purchaseUnitPrice: 17.25, nativeDescription: "Current item" }] }]);
  return f;
}
function reserved() {
  const f = install(); m.events.mockResolvedValue([{ id: 41, status: "reserved", processingToken: "claim-token", containerControlId: f.facts.recordId, eventKind: "recurring", proposedPoNumber: f.plan.nextPoNumber, billingPeriodStart: f.plan.nextPeriodStart, billingPeriodEnd: f.plan.nextPeriodEnd }]); Object.assign(f.row, { status: "reserved", processingToken: "claim-token", firstApEventId: 41 });
  m.existing.mockResolvedValue(f.row); vi.setSystemTime(new Date(`${f.plan.nextPeriodStart}T01:00:00Z`));
  const payload: FinancialDraftPayload = { method: "POST", endpoint: "/PurchaseOrders", documentFamily: "purchase_order", documentNumber: f.plan.nextPoNumber, expectedXeroDocumentId: null, idempotencyKey: "offline-first-po", body: { PurchaseOrders: [{ PurchaseOrderID: undefined, PurchaseOrderNumber: f.plan.nextPoNumber, Reference: f.facts.controlNumber, Status: "DRAFT", CurrencyCode: "AUD", Contact: { ContactID: f.plan.supplierContactId }, Date: f.plan.nextPeriodStart, LineAmountTypes: "Exclusive", LineItems: [{ ItemCode: "HC 40 E", Quantity: 30, UnitAmount: 17.25, AccountCode: "312", TaxType: "INPUT", Description: `${f.facts.containerNumber}, ${f.facts.containerType} Extended Hire @ $17.25 per day from ${formatForHireDate(f.plan.nextPeriodStart)} to ${formatForHireDate(f.plan.nextPeriodEnd)}` }] }] } };
  return { ...f, write: { recordId: f.facts.recordId, handoverId: 9, planHash: f.plan.planHash, eventId: 41, token: "claim-token", payload } };
}
function noWrites() { expect(m.approve).not.toHaveBeenCalled(); expect(m.createEvent).not.toHaveBeenCalled(); expect(m.sourceWrite).not.toHaveBeenCalled(); expect(m.xeroWrite).not.toHaveBeenCalled(); }
beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-15T01:00:00Z"));
  m.enabled.mockReturnValue(true); m.events.mockResolvedValue([]); m.existing.mockResolvedValue(null); m.approve.mockImplementation(async value => value); install();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("manual handover read-only preview and exact approval", () => {
  it("default-off enrollment and execution reject before any source, ledger or Xero read/write", async () => {
    m.enabled.mockReturnValue(false);
    await expect(enrollManualForHireHandover(fixture().approval)).rejects.toThrow(/disabled/i);
    await expect(revalidateManualForHireOpeningPoint({ recordId: "24x1929", handoverId: 9 })).rejects.toThrow(/disabled/i);
    for (const read of [m.source, m.events, m.existing, m.evidence, m.preflight]) expect(read).not.toHaveBeenCalled(); noWrites();
  });
  it("requires exact administrator approval, true stop flag and literal acknowledgement before reads", async () => {
    for (const bad of [{ approvedBy: 0 }, { approvedBy: 1.5 }, { confirmedLatestCoverage: false }, { confirmedNoOtherFutureCoverage: false }, { manualCreationStopped: false }, { acknowledgement: "YES" }]) {
      vi.clearAllMocks();
      await expect(enrollManualForHireHandover({ ...fixture().approval, ...bad } as any)).rejects.toThrow();
      for (const read of [m.source, m.events, m.existing, m.evidence, m.preflight]) expect(read).not.toHaveBeenCalled(); noWrites();
    }
  });
  it("disabled preview stays read-only, creates no AP receipt and retains truthful complete:false with admin attestation", async () => {
    m.enabled.mockReturnValue(false); const f = fixture(); const before = structuredClone(f.raw);
    m.evidence.mockResolvedValue(f.raw); const result = await previewManualForHireHandover(f.input);
    expect(result).toMatchObject({ state: "ready", noFinancialWrites: true, enrollmentEnabled: false, evidence: { complete: false, coverageAttestation: f.evidence.coverageAttestation } });
    expect(result.plan?.xeroEvidenceHash).toBe(f.plan.xeroEvidenceHash); expect(f.raw).toEqual(before);
    expect(m.source).toHaveBeenCalledWith(f.input.recordId); expect(m.evidence).toHaveBeenCalledWith({ manualPoNumber: "HC1929", controlNumber: "C1929", supplierName: "Hire Supplier" }); noWrites();
  });
  it("API incomplete evidence requires both separate confirmations and a positive server reviewer, never accepts a raw caller attestation", async () => {
    const f = fixture(); m.evidence.mockResolvedValue(f.evidence);
    for (const extra of [{ confirmedLatestCoverage: false }, { confirmedNoOtherFutureCoverage: false }, { reviewedBy: 0 }, { reviewedBy: -7 }, { reviewedBy: 1.5 }]) {
      expect(await previewManualForHireHandover({ ...f.input, ...extra })).toMatchObject({ state: "held", plan: null, proposal: null, noFinancialWrites: true });
    }
    noWrites();
  });
  it("initial and recurring baselines propose only their next exact consecutive 30-day extension at current purchase rate", async () => {
    for (const suffix of [1, 2, 7]) {
      const f = install(fixture(suffix)); const result = await previewManualForHireHandover(f.input);
      expect(result.state).toBe("ready"); expect(result.plan).toEqual(f.plan);
      expect(result.proposal).toMatchObject({ documentType: "recurring_for_hire", proposedDocumentNumber: f.plan.nextPoNumber, issueDate: new Date(`${f.plan.nextPeriodStart}T00:00:00Z`), partySourceId: "contact-44", lineItems: [{ quantity: 30, unitAmount: 17.25, itemCode: "HC 40 E" }] });
      expect(result.proposal?.lineItems[0].description).toContain(`from ${formatForHireDate(f.plan.nextPeriodStart)} to ${formatForHireDate(f.plan.nextPeriodEnd)}`);
    }
    noWrites();
  });
  it("holds invalid initial/recurring quantity, item, duration and partial container token without financial writes", async () => {
    for (const kind of ["initialQuantity", "initialItem", "recurringQuantity", "recurringDuration", "partialToken"]) {
      const f = fixture(kind.startsWith("initial") ? 1 : 2); const line = f.raw.manualPo.LineItems[0];
      if (kind === "initialQuantity") line.Quantity = 30;
      if (kind === "initialItem") line.ItemCode = "HC 40 E";
      if (kind === "recurringQuantity") line.Quantity = 1;
      if (kind === "recurringDuration") line.Description = line.Description.replace("12/12/26", "13/12/26");
      if (kind === "partialToken") line.Description = line.Description.replace("TGHU1234567", "XTGHU1234567");
      install(f); expect((await previewManualForHireHandover(f.input)).state).toBe("held");
    }
    noWrites();
  });
  it("AP reserved, completed-draft and reconciliation receipts exclude enrollment before manual Xero read", async () => {
    for (const status of ["reserved", "drafts_created", "reconciliation_required"]) {
      vi.clearAllMocks(); m.events.mockResolvedValue([{ id: 41, status }]);
      expect((await previewManualForHireHandover(fixture().input)).state).toBe("held");
      await expect(enrollManualForHireHandover(fixture().approval)).rejects.toThrow(/AP-created|claimed|uncertain/i);
      expect(m.evidence).not.toHaveBeenCalled(); noWrites();
    }
  });
  it("any existing immutable baseline, including reserved or completed, cannot be replaced or re-enrolled", async () => {
    for (const status of ["approved", "reserved", "completed", "reconciliation_required", "dehired"]) {
      m.existing.mockResolvedValue({ ...fixture().row, status });
      expect((await previewManualForHireHandover(fixture().input)).state).toBe("held");
      await expect(enrollManualForHireHandover(fixture().approval)).rejects.toThrow(/immutable|overwritten|re-enrolled/i);
    }
    expect(m.evidence).not.toHaveBeenCalled(); noWrites();
  });
  it("approval freshly reconstructs the exact preview hash and saves the same complete:false read plus admin coverage attestation", async () => {
    const f = fixture(); const result = await previewManualForHireHandover(f.input);
    const refreshed = structuredClone(f.raw); refreshed.manualPo.UpdatedDateUTC = "ignored-refresh-metadata"; m.evidence.mockResolvedValue(refreshed);
    await enrollManualForHireHandover({ ...f.approval, expectedPlanHash: result.plan!.planHash });
    expect(m.evidence).toHaveBeenCalledTimes(2); expect(m.preflight).toHaveBeenCalledTimes(2);
    expect(m.approve).toHaveBeenCalledTimes(1);
    expect(m.approve).toHaveBeenCalledWith({ plan: f.plan, evidence: { ...refreshed, coverageAttestation: f.evidence.coverageAttestation, lumpSumManual: undefined }, approvedBy: 7, manualCreationStopped: true, acknowledgement: "FUTURE_ONLY_MANUAL_PO_HANDOVER" });
    expect(m.createEvent).not.toHaveBeenCalled(); expect(m.xeroWrite).not.toHaveBeenCalled(); expect(m.sourceWrite).not.toHaveBeenCalled();
  });
  it("stale plan hash, changed source/manual coverage and canonical-number mismatch never reach approval", async () => {
    for (const kind of ["hash", "source", "coverage", "canonical"]) {
      const f = install();
      if (kind === "source") m.source.mockResolvedValue({ ...f.facts, containerNumber: "ABCD9876543" });
      if (kind === "coverage") f.raw.manualPo.LineItems[0].UnitAmount = 99;
      if (kind === "canonical") m.source.mockResolvedValue({ ...f.facts, controlNumber: "C1930" });
      await expect(enrollManualForHireHandover({ ...f.approval, expectedPlanHash: kind === "hash" ? "0".repeat(64) : f.plan.planHash })).rejects.toThrow();
    }
    noWrites();
  });
  it("current collision, wrong exact contact or missing/non-positive purchase rate fail closed", async () => {
    const good = [{ duplicateState: "not_found", contactCheck: { found: true, contactId: "contact-44" }, itemChecks: [{ found: true, itemCode: "HC 40 E", purchaseUnitPrice: 17.25 }] }];
    for (const change of ["collision", "contact", "rate", "missingItem"]) {
      const result = structuredClone(good);
      if (change === "collision") result[0].duplicateState = "found";
      if (change === "contact") result[0].contactCheck.contactId = "other-contact";
      if (change === "rate") result[0].itemChecks[0].purchaseUnitPrice = 0;
      if (change === "missingItem") result[0].itemChecks = [];
      m.preflight.mockResolvedValue(result); expect((await previewManualForHireHandover(fixture().input)).state).toBe("held");
      await expect(enrollManualForHireHandover(fixture().approval)).rejects.toThrow();
    }
    noWrites();
  });
});

describe("immutable approved opening point and first-write verification", () => {
  it("completed, reserved, reconciliation and dehired baselines cannot replay as an unclaimed predecessor", async () => {
    for (const status of ["completed", "reserved", "reconciliation_required", "dehired"]) {
      m.existing.mockResolvedValue({ ...fixture().row, status });
      await expect(revalidateManualForHireOpeningPoint({ recordId: "24x1929", handoverId: 9 })).rejects.toThrow(/replay|claimed|completed/i);
    }
    expect(m.source).not.toHaveBeenCalled(); expect(m.evidence).not.toHaveBeenCalled(); noWrites();
  });
  it("unapproved, tampered-hash, claimed approved or mirrored canonical-column mismatches reject before fresh reads", async () => {
    for (const patch of [{ approvedBy: 0 }, { manualCreationStopped: false }, { acknowledgement: "YES" }, { processingToken: "other" }, { firstApEventId: 41 }, { planHash: "0".repeat(64) }, { manualPoNumber: "HC1930" }, { nextBillingDate: "2027-01-01" }]) {
      m.existing.mockResolvedValue({ ...fixture().row, ...patch });
      await expect(revalidateManualForHireOpeningPoint({ recordId: "24x1929", handoverId: 9 })).rejects.toThrow();
    }
    expect(m.source).not.toHaveBeenCalled(); expect(m.evidence).not.toHaveBeenCalled(); noWrites();
  });
  it("fresh read retains stored reviewer/attestation unchanged and does not fabricate completeness", async () => {
    const f = fixture(); m.existing.mockResolvedValue(f.row);
    const fresh = { ...structuredClone(f.raw), coverageAttestation: { confirmedLatestCoverage: true, confirmedNoOtherFutureCoverage: true, reviewedBy: 999 } }; m.evidence.mockResolvedValue(fresh);
    const result = await revalidateManualForHireOpeningPoint({ recordId: f.facts.recordId, handoverId: 9, now: f.plan.nextPeriodStart });
    expect(result.plan).toEqual(f.plan); expect(fresh.complete).toBe(false); expect(fresh.coverageAttestation.reviewedBy).toBe(999);
    expect(m.evidence).toHaveBeenCalledTimes(1); noWrites();
  });
  it("changed source identity, ineligible state, manual evidence or stored Accounts coverage hash forces reconciliation", async () => {
    for (const kind of ["supplier", "container", "dehired", "coverage", "attestation"]) {
      const f = install(); m.existing.mockResolvedValue(f.row);
      if (kind === "supplier") m.source.mockResolvedValue({ ...f.facts, supplierVtigerId: "18x45" });
      if (kind === "container") m.source.mockResolvedValue({ ...f.facts, containerNumber: "ABCD9876543" });
      if (kind === "dehired") m.source.mockResolvedValue({ ...f.facts, status: "DEHIRED" });
      if (kind === "coverage") f.raw.manualPo.LineItems[0].Description += " changed";
      if (kind === "attestation") f.row.evidence.coverageAttestation.reviewedBy = 8;
      await expect(revalidateManualForHireOpeningPoint({ recordId: f.facts.recordId, handoverId: 9, now: f.plan.nextPeriodStart })).rejects.toThrow(/differs|changed|coverage|confirmation/i);
    }
    noWrites();
  });
  it("not-effective or expired first periods never roll forward or perform historical catch-up", async () => {
    const f = fixture(); m.existing.mockResolvedValue(f.row);
    for (const now of ["2026-12-13", "2027-01-13", "2027-05-01"]) {
      await expect(revalidateManualForHireOpeningPoint({ recordId: f.facts.recordId, handoverId: 9, now })).rejects.toThrow(/effective|expired|catch-up/i);
    }
    expect(m.evidence).not.toHaveBeenCalled(); noWrites();
  });
  it("a self-rehashed but altered first period still fails exact business reconstruction", async () => {
    const f = fixture(); f.row.plan.nextPeriodEnd = "2027-01-13";
    const { planHash: _, ...unsigned } = f.row.plan; f.row.plan.planHash = financialSha256(unsigned); f.row.planHash = f.row.plan.planHash;
    m.existing.mockResolvedValue(f.row);
    await expect(revalidateManualForHireOpeningPoint({ recordId: f.facts.recordId, handoverId: 9, now: f.plan.nextPeriodStart })).rejects.toThrow(/reconstruct|exact approved/i); noWrites();
  });
  it("only the exact reserved event and token can verify the next AUD Draft PO, without writing it", async () => {
    const f = reserved(); m.events.mockResolvedValue([{ id: 41, status: "reserved", processingToken: "claim-token", containerControlId: f.facts.recordId, eventKind: "recurring", proposedPoNumber: f.plan.nextPoNumber, billingPeriodStart: f.plan.nextPeriodStart, billingPeriodEnd: f.plan.nextPeriodEnd }]);
    await expect(verifyManualForHireFirstWrite(f.write)).resolves.toBeUndefined();
    for (const change of [{ token: "wrong" }, { eventId: 42 }, { handoverId: 10 }, { planHash: "0".repeat(64) }]) await expect(verifyManualForHireFirstWrite({ ...f.write, ...change })).rejects.toThrow();
    m.events.mockResolvedValue([{ id: 41, status: "reserved" }, { id: 42, status: "drafts_created" }]);
    await expect(verifyManualForHireFirstWrite(f.write)).rejects.toThrow(/AP-created|claimed|uncertain/i); noWrites();
  });
  it("rejects altered plan date, endpoint, number, contact, Draft status, currency, quantity, account or tax", async () => {
    const f = reserved();
    for (const kind of ["method", "endpoint", "target", "number", "date", "contact", "status", "currency", "quantity", "account", "tax", "extraOrder", "extraLine"]) {
      const p = structuredClone(f.write.payload); const order = (p.body.PurchaseOrders as any[])[0]; const line = order.LineItems[0];
      if (kind === "method") p.method = "PUT";
      if (kind === "endpoint") p.endpoint = "/Invoices";
      if (kind === "target") p.expectedXeroDocumentId = "manual-po-id";
      if (kind === "number") p.documentNumber = "HC1929-3";
      if (kind === "date") order.Date = "2026-12-15";
      if (kind === "contact") order.Contact.ContactID = "other";
      if (kind === "status") order.Status = "AUTHORISED";
      if (kind === "currency") order.CurrencyCode = "USD";
      if (kind === "quantity") line.Quantity = 1;
      if (kind === "account") line.AccountCode = "313";
      if (kind === "tax") line.TaxType = "OUTPUT";
      if (kind === "extraOrder") (p.body.PurchaseOrders as any[]).push(structuredClone(order));
      if (kind === "extraLine") order.LineItems.push(structuredClone(line));
      await expect(verifyManualForHireFirstWrite({ ...f.write, payload: p })).rejects.toThrow();
    }
    noWrites();
  });
  it("binds the actual payload PO number, exact size/container/type/period, Reference and positive purchase rate", async () => {
    const f = reserved();
    for (const kind of ["actualNumber", "size", "container", "type", "period", "reference", "zeroRate", "negativeRate", "inclusive", "invoiceSidecar"]) {
      const p = structuredClone(f.write.payload); const order = (p.body.PurchaseOrders as any[])[0]; const line = order.LineItems[0];
      if (kind === "actualNumber") order.PurchaseOrderNumber = "HC1929-99";
      if (kind === "size") line.ItemCode = "HC 20 E";
      if (kind === "container") line.Description = line.Description.replace("TGHU1234567", "XTGHU1234567");
      if (kind === "type") line.Description = line.Description.replace("40 Foot Standard", "40 Foot High Cube");
      if (kind === "period") line.Description = line.Description.replace("12/01/27", "13/01/27");
      if (kind === "reference") order.Reference = "C1930";
      if (kind === "zeroRate") line.UnitAmount = 0;
      if (kind === "negativeRate") line.UnitAmount = -1;
      if (kind === "inclusive") order.LineAmountTypes = "Inclusive";
      if (kind === "invoiceSidecar") p.body.Invoices = [{ Status: "DRAFT" }];
      await expect(verifyManualForHireFirstWrite({ ...f.write, payload: p }), kind).rejects.toThrow();
    }
    noWrites();
  });
});


describe("controlled legacy lump-sum and prior AP service integration", () => {
  function installMixed() {
    const f = offlineMixedFixture();
    m.source.mockResolvedValue(f.facts); m.evidence.mockResolvedValue({ ...f.evidence, coverageAttestation: undefined, lumpSumManual: undefined });
    m.events.mockResolvedValue([f.ap]);
    m.preflight.mockResolvedValue([{ duplicateState: "not_found", contactCheck: { found: true, contactId: "offline-contact" }, itemChecks: [{ found: true, itemCode: "HC 20 E", purchaseUnitPrice: 4.5, nativeDescription: "Current daily item" }] }]);
    const input = { recordId: f.facts.recordId, manualPoNumber: f.plan.manualPoNumber, coveredThrough: "15/12/26", effectiveFrom: f.plan.effectiveFrom,
      confirmedLatestCoverage: true, confirmedNoOtherFutureCoverage: true, confirmedCoveredThrough: true, reviewedBy: 7, lumpSumManual: { confirmed: true as const, lineIndex: 0, amount: 139.5 } };
    return { ...f, input };
  }
  it("binds the exact AP initial plus normalized Accounts coveredThrough without importing a manual AP receipt", async () => {
    const f = installMixed(); const result = await previewManualForHireHandover(f.input);
    expect(result).toMatchObject({ state: "ready", plan: { coverageSource: "accounts_attested", manualPeriodStart: null, manualSuffix: 1, nextPoNumber: "HC1920-2", priorApAnchor: { id: f.ap.id } }, evidence: { complete: false, coverageAttestation: { coveredThrough: "2026-12-15", confirmedCoveredThrough: true, reviewedBy: 7 }, lumpSumManual: { confirmed: true, reviewedBy: 7, amount: 139.5, lineIndex: 0 } } });
    expect(result.proposal?.lineItems[0]).toMatchObject({ unitAmount: 4.5, quantity: 30, itemCode: "HC 20 E" });
    expect(result.plan).toEqual(f.plan);
    await enrollManualForHireHandover({ ...f.input, expectedPlanHash: result.plan!.planHash, approvedBy: 7, manualCreationStopped: true, acknowledgement: "FUTURE_ONLY_MANUAL_PO_HANDOVER" });
    expect(m.approve).toHaveBeenCalledWith(expect.objectContaining({ plan: f.plan })); expect(m.createEvent).not.toHaveBeenCalled(); expect(m.xeroWrite).not.toHaveBeenCalled();
  });
  it("does not fabricate lump-sum approval from API evidence or quantity, nor accept wrong amount/index", async () => {
    const f = installMixed(); m.evidence.mockResolvedValue(f.evidence);
    for (const patch of [{ confirmedCoveredThrough: false }, { lumpSumManual: undefined }, { lumpSumManual: { confirmed: true as const, lineIndex: 0, amount: 135 } }, { lumpSumManual: { confirmed: true as const, lineIndex: 1, amount: 139.5 } }, { confirmedNoOtherFutureCoverage: false }])
      expect((await previewManualForHireHandover({ ...f.input, ...patch })).state).toBe("held");
    noWrites();
  });
  it("rejects a later AP completion or uncertain receipt before approval and rejects stale anchor evidence on revalidation", async () => {
    const f = installMixed();
    m.events.mockResolvedValue([f.ap, { ...f.first, status: "drafts_created", executionId: 101, xeroPurchaseOrderId: "other" }]);
    expect((await previewManualForHireHandover(f.input)).state).toBe("held");
    m.events.mockResolvedValue([f.ap]); m.existing.mockResolvedValue(f.opening);
    expect((await revalidateManualForHireOpeningPoint({ recordId: f.facts.recordId, handoverId: 9, now: f.plan.nextPeriodStart })).plan).toEqual(f.plan);
    m.events.mockResolvedValue([{ ...f.ap, executionId: 102 }]);
    await expect(revalidateManualForHireOpeningPoint({ recordId: f.facts.recordId, handoverId: 9, now: f.plan.nextPeriodStart })).rejects.toThrow(/anchor/);
    noWrites();
  });
  it("retains strict current supplier lookup and does not override historical supplier mismatch", async () => {
    const f = installMixed(); m.evidence.mockRejectedValue(new Error("Manual PO supplier ContactID differs from current exact VTiger supplier"));
    const result = await previewManualForHireHandover(f.input);
    expect(result.state).toBe("held"); expect(m.evidence).toHaveBeenCalledWith({ manualPoNumber: "HC1920-1", controlNumber: "C1920", supplierName: "Offline Same Supplier" });
    expect(m.preflight).not.toHaveBeenCalled(); noWrites();
  });
});
