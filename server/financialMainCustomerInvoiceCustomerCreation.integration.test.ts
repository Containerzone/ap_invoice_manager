import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FinancialDraftPayload } from "./financialProductionWriter";
import type { ProposedFinancialDocument } from "./financialWorkflowEngine";
import { MAIN_CUSTOMER_INVOICE_RULES_HASH } from "./financialMainCustomerInvoiceDrafts";
import { financialSha256 } from "./financialProposalIntegrity";

/**
 * Offline integration: Main orchestration, current billing-party source reads,
 * v2 resolution/creation/readback, and the VTiger authenticated reader are real.
 * All persistence, Xero auth/preflight, request scheduling, and invoice-writing
 * boundaries are mocked. No real credentials, database, or network are used.
 * Invoice payload preparation is deliberately a boundary stub; the actual
 * production writer/payload builder has its own tests.
 */
const m = vi.hoisted(() => ({
  get: vi.fn(), post: vi.fn(), forbidden: vi.fn(), auth: vi.fn(),
  boundedGet: vi.fn(), run: vi.fn(), preflight: vi.fn(), getConfig: vi.fn(),
  recordPreview: vi.fn(), getEvent: vi.fn(), claim: vi.fn(), bind: vi.fn(),
  completeMain: vi.fn(), holdMain: vi.fn(), contactHold: vi.fn(), requireLedger: vi.fn(),
  reserve: vi.fn(), completeContact: vi.fn(), holdContact: vi.fn(),
  prepare: vi.fn(), bindPayload: vi.fn(), writer: vi.fn(), deduction: vi.fn(),
}));

vi.mock("axios", () => ({
  default: Object.assign(m.forbidden, {
    get: m.get, post: m.post, request: m.forbidden, create: m.forbidden,
    put: m.forbidden, patch: m.forbidden, delete: m.forbidden,
    head: m.forbidden, options: m.forbidden,
  }),
}));
vi.mock("./db", () => ({ getDb: m.forbidden }));
vi.mock("./xeroService", () => ({ getXeroReadAuthWithRefresh: m.auth }));
vi.mock("./xeroRequestManager", () => ({ runBoundedXeroGet: m.boundedGet, runXeroRequest: m.run }));
vi.mock("./financialReadOnlyXeroService", () => ({ preflightFinancialXeroIntents: m.preflight }));
vi.mock("./financialWorkflowDb", () => ({ getFinancialWorkflowConfig: m.getConfig, upsertFinancialWorkflowConfig: m.forbidden }));
vi.mock("./financialMainCustomerInvoiceDb", () => ({
  recordMainCustomerInvoicePreview: m.recordPreview, getMainCustomerInvoiceEvent: m.getEvent,
  getMainCustomerInvoiceEvents: m.forbidden, claimMainCustomerInvoicePreview: m.claim,
  bindMainCustomerInvoicePayload: m.bind, completeMainCustomerInvoiceDraft: m.completeMain,
  holdMainCustomerInvoiceExecution: m.holdMain,
  recordMainCustomerInvoiceContactHold: m.contactHold,
}));
vi.mock("./financialCustomerContactDb", () => ({
  requireFinancialCustomerContactLedger: m.requireLedger,
  reserveFinancialCustomerContactEvent: m.reserve,
  completeFinancialCustomerContactEvent: m.completeContact,
  holdFinancialCustomerContactEvent: m.holdContact,
  getFinancialCustomerContactEvent: m.forbidden,
}));
vi.mock("./financialProductionWriter", () => ({
  prepareFinancialDraftPayload: m.prepare,
  bindFinancialDraftPayloadIdempotencyKey: m.bindPayload,
}));
vi.mock("./financialWriterExecutionService", () => ({ executeGuardedFinancialWriterCommand: m.writer }));
vi.mock("./financialDepositMainDeductionService", () => ({ processAutomaticDepositMainDeduction: m.deduction }));
// Any accidental fallback into the legacy contact flow is a test failure.
vi.mock("./financialCustomerContactSource", () => ({ readCurrentCustomerContactSource: m.forbidden }));
vi.mock("./financialCustomerContactService", () => ({ resolveOrCreateAutomaticCustomerContact: m.forbidden }));

const VTIGER_ENDPOINT = "https://vtiger.offline.invalid/webservice.php";
const XERO_BASE = "https://api.xero.com/api.xro/2.0";
const AUTH = { token: "offline-xero-token", tenantId: "offline-xero-tenant" };
const SESSION = "offline-vtiger-session";
const CONTACT_ID = "offline-created-customer";
const ORGANISATION = { id: "4x2", name: "Customer Pty Ltd", email: "customer@example.test", kind: "organisation" as const };
const INDIVIDUAL = { id: "4x3", name: "Casey Customer", email: "casey@example.test", kind: "individual" as const };
type Party = typeof ORGANISATION | typeof INDIVIDUAL;
type XeroProfile = { ContactID: string; Name: string; EmailAddress: string; ContactStatus: string };
type ContactEvent = { id: number; status: string; xeroContactId?: string };
type PreflightSnapshot = { document: ProposedFinancialDocument; contactId: string | null };

let originalEnv: NodeJS.ProcessEnv;
let party: Party;
let records: Record<string, Record<string, unknown>>;
let profile: XeroProfile | null;
let contactEvent: ContactEvent | null;
let trace: string[];
let unexpected: string[];
let snapshots: PreflightSnapshot[];
let duplicateState: "not_found" | "found";
let accountMode: "active" | "inactive" | "missing" | "mismatch";
let postStatus: number | null;
let invalidateAccountAfterCreate: boolean;
let postReadbackMutation: "main_source" | "customer_source" | "contact_id" | "source_exception" | null;

function forbidden(message: string): never {
  unexpected.push(message);
  throw new Error(`Unexpected offline transport/boundary call: ${message}`);
}
function response(data: unknown) { return { data: structuredClone(data), headers: {} }; }
function vtigerResponse(result: unknown) { return response({ success: true, result }); }
function retrieveIds() {
  return m.get.mock.calls
    .filter(([url, config]) => url === VTIGER_ENDPOINT && config?.params?.operation === "retrieve")
    .map(([, config]) => config.params.id as string);
}
function sourceReadSequence(selected: Party) {
  return ["5x77", "20x9", selected.id];
}
function factsReadSequence(selected: Party) {
  return [...sourceReadSequence(selected), "14x1"];
}
function contactPosts() { return m.post.mock.calls.filter(([url]) => url === `${XERO_BASE}/Contacts`); }
function searches() {
  return m.get.mock.calls.filter(([url]) => url === `${XERO_BASE}/Contacts`)
    .map(([, config]) => config.params.searchTerm as string);
}
function assertOneAuthentication() {
  const challenges = m.get.mock.calls.filter(([url, config]) => url === VTIGER_ENDPOINT && config.params.operation === "getchallenge");
  const logins = m.post.mock.calls.filter(([url]) => url === VTIGER_ENDPOINT);
  expect(challenges).toHaveLength(1);
  expect(logins).toHaveLength(1);
  expect(new URLSearchParams(logins[0]![1]).get("operation")).toBe("login");
  const authenticatedGets = m.get.mock.calls.filter(([url, config]) => url === VTIGER_ENDPOINT && config.params.operation !== "getchallenge");
  expect(authenticatedGets.length).toBeGreaterThan(0);
  for (const [, config] of authenticatedGets) expect(config.params.sessionName).toBe(SESSION);
}
function selectIndividual() {
  party = INDIVIDUAL;
  records["5x77"]!.related_to = "";
}
function setExistingActiveProfile() {
  profile = { ContactID: "offline-existing-customer", Name: party.name, EmailAddress: party.email, ContactStatus: "ACTIVE" };
}
async function services() {
  return import("./financialMainCustomerInvoiceService");
}

beforeEach(() => {
  // Replace the whole environment, not just gates: deployment credentials and
  // unrelated live flags are unavailable to every imported real implementation.
  originalEnv = process.env;
  process.env = {
    NODE_ENV: "test", TZ: "UTC",
    VTIGER_URL: "https://vtiger.offline.invalid",
    VTIGER_USERNAME: "offline-user", VTIGER_ACCESS_KEY: "offline-key",
    DATABASE_URL: "", FINANCIAL_LIVE_WRITES_ENABLED: "false",
    FINANCIAL_MAIN_CUSTOMER_INVOICE_AUTOMATIC_ENABLED: "true",
    FINANCIAL_CUSTOMER_CONTACT_V2_ENABLED: "true",
    FINANCIAL_CUSTOMER_CONTACT_AUTOMATIC_ENABLED: "true",
    FINANCIAL_DEPOSIT_MAIN_DEDUCTION_AUTOMATIC_ENABLED: "false",
  };
  vi.resetModules(); // resets the real VTiger session lease/AsyncLocalStorage per case
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-11T00:00:00.000Z"));
  party = ORGANISATION;
  profile = null;
  contactEvent = null;
  trace = [];
  unexpected = [];
  snapshots = [];
  duplicateState = "not_found";
  accountMode = "active";
  postStatus = null;
  invalidateAccountAfterCreate = false;
  postReadbackMutation = null;
  records = {
    "5x77": {
      id: "5x77", potential_no: "D702877", cf_potentials_quotereference: "20x9",
      related_to: "4x2", contact_id: "4x3",
      // Stale direct names/Quote links must never override current linked parties.
      organizationname: "Wrong direct organisation", contactname: "Wrong direct person",
      cf_potentials_containersituationselectone: "SHIPPER OWN",
      cf_potentials_pickuplocation: "Origin", cf_potentials_deliverylocation: "Destination",
      cf_potentials_fullcontainercollectiondate: "2026-10-12", cf_potentials_depositstatus: "PENDING",
      modifiedtime: "2026-10-11T01:00:00Z",
    },
    "20x9": {
      id: "20x9", quote_no: "Q-702877", account_id: "3x200", contact_id: "4x999",
      LineItems: { 1: { productid: "14x1", quantity: "2", listprice: "250" } },
      modifiedtime: "2026-10-11T02:00:00Z",
    },
    "4x2": { id: "4x2", accountname: ORGANISATION.name, email1: ORGANISATION.email },
    "4x3": { id: "4x3", firstname: "Casey", lastname: "Customer", email: INDIVIDUAL.email },
    "14x1": { id: "14x1", servicename: "Transport - Loaded Container" },
  };
  m.forbidden.mockImplementation((...args) => forbidden(JSON.stringify(args)));
  vi.stubGlobal("fetch", m.forbidden);
  m.auth.mockResolvedValue(AUTH);
  m.getConfig.mockResolvedValue([{
    configKey: "financial-automation.main-customer-invoice-release",
    configValue: {
      releaseKey: "MAIN-offline-integration", rulesHash: MAIN_CUSTOMER_INVOICE_RULES_HASH,
      enabled: true, approvedBy: 7, approvedAt: "2026-10-01T00:00:00Z",
      effectiveFrom: "2026-10-01T00:00:00Z", migrationScope: "new_events_only",
      mainInvoiceOnlyVtigerBranch: true, operationsMainInvoiceHandoff: true,
    },
  }]);
  m.get.mockImplementation(async (url: string, config: any) => {
    if (url === VTIGER_ENDPOINT) {
      if (config?.timeout !== 20_000) return forbidden("VTiger GET timeout/config");
      const params = config?.params;
      if (params?.operation === "getchallenge") {
        if (params.username !== "offline-user" || Object.keys(params).length !== 2) return forbidden("VTiger challenge credentials/config");
        trace.push("vtiger:challenge");
        return vtigerResponse({ token: "offline-challenge" });
      }
      if (params?.sessionName !== SESSION) return forbidden("VTiger unauthenticated GET");
      if (params.operation === "describe" && params.elementType === "Potentials") {
        trace.push("vtiger:describe");
        return vtigerResponse({ name: "Potentials", fields: [
          { name: "cf_potentials_fullcontainercollectiondate", label: "Full Container Pickup DATE", type: { name: "date" }, mandatory: false },
          { name: "cf_potentials_depositstatus", label: "Deposit Status", type: { name: "picklist" }, mandatory: false },
        ] });
      }
      if (params.operation === "retrieve" && records[params.id]) {
        trace.push(`vtiger:retrieve:${params.id}`);
        if (postReadbackMutation === "source_exception" && profile && params.id === "5x77") {
          throw new Error("offline current Deal read unavailable");
        }
        return vtigerResponse(records[params.id]);
      }
      return forbidden(`VTiger GET ${JSON.stringify(params)}`);
    }
    if (config?.headers?.Authorization !== `Bearer ${AUTH.token}` || config?.headers?.["Xero-tenant-id"] !== AUTH.tenantId) {
      return forbidden(`Xero GET auth ${url}`);
    }
    if (url === `${XERO_BASE}/Organisation` && !config.params) {
      trace.push("xero:tenant");
      return response({ Organisations: [{ Name: "CONTAINERZONE offline fixture" }] });
    }
    if (url === `${XERO_BASE}/Contacts`) {
      const term = config?.params?.searchTerm;
      if (![party.name, party.email].includes(term) || Object.keys(config.params).length !== 1) return forbidden(`Xero contact search ${term}`);
      trace.push(`xero:search:${term}`);
      return response({ Contacts: profile && [profile.Name, profile.EmailAddress].includes(term) ? [profile] : [] });
    }
    if (url === `${XERO_BASE}/Contacts/${CONTACT_ID}` && profile?.ContactID === CONTACT_ID && !config.params) {
      trace.push("xero:readback");
      const confirmedResponse = response({ Contacts: [profile] });
      // Drift happens only after capturing the correct active readback identity.
      if (postReadbackMutation === "main_source") records["20x9"]!.modifiedtime = "2026-10-11T03:00:00Z";
      if (postReadbackMutation === "customer_source") records[party.id]!.email1 = "changed@example.test";
      if (postReadbackMutation === "contact_id") profile.ContactID = "offline-changed-contact";
      return confirmedResponse;
    }
    return forbidden(`GET ${url}`);
  });
  m.post.mockImplementation(async (url: string, body: unknown, config: any) => {
    if (url === VTIGER_ENDPOINT) {
      if (typeof body !== "string" || config?.headers?.["Content-Type"] !== "application/x-www-form-urlencoded" || config.timeout !== 20_000) return forbidden("VTiger non-form login");
      const form = new URLSearchParams(body);
      if (form.get("operation") !== "login" || form.get("username") !== "offline-user" || form.get("accessKey") !== createHash("md5").update("offline-challengeoffline-key").digest("hex") || [...form.keys()].length !== 3) return forbidden("VTiger POST other than exact authentication");
      trace.push("vtiger:formlogin");
      return vtigerResponse({ sessionName: SESSION });
    }
    if (url !== `${XERO_BASE}/Contacts`) return forbidden(`POST ${url}`);
    if (contactPosts().length !== 1 || profile) return forbidden("second/unnecessary contact POST");
    if (process.env.FINANCIAL_CUSTOMER_CONTACT_AUTOMATIC_ENABLED !== "true" || config?.headers?.Authorization !== `Bearer ${AUTH.token}` || config?.headers?.["Xero-tenant-id"] !== AUTH.tenantId || config?.headers?.["Content-Type"] !== "application/json" || !/^[a-f0-9]{64}$/.test(config?.headers?.["Idempotency-Key"])) return forbidden("unguarded contact POST");
    expect(body).toEqual({ Contacts: [{ Name: party.name, EmailAddress: party.email }] });
    trace.push("xero:contact-post");
    if (postStatus) throw Object.assign(new Error("offline uncertain gateway"), { response: { status: postStatus } });
    profile = { ContactID: CONTACT_ID, Name: party.name, EmailAddress: party.email, ContactStatus: "ACTIVE" };
    return response({ Contacts: [profile] });
  });
  m.boundedGet.mockImplementation(async (auth: unknown, name: string, url: string, config: unknown) => {
    if (JSON.stringify(auth) !== JSON.stringify(AUTH) || ![
      "GET customer-contact-v2-tenant", "GET customer-contact-v2-name",
      "GET customer-contact-v2-email", "GET customer-contact-v2-readback",
    ].includes(name)) return forbidden(`bounded GET ${name}`);
    return m.get(url, config);
  });
  m.run.mockImplementation(async (auth: unknown, name: string, operation: () => Promise<unknown>, options: unknown) => {
    if (JSON.stringify(auth) !== JSON.stringify(AUTH) || name !== "POST customer-contact-v2") return forbidden(`Xero request ${name}`);
    expect(options).toEqual({ retryTransientGatewayFailures: false });
    return operation(); // no queues, caches, real DB, or retrying writes
  });
  m.preflight.mockImplementation(async (documents: ProposedFinancialDocument[]) => {
    if (documents.length !== 1 || snapshots.length >= 4) return forbidden("unexpected invoice preflight");
    const document = documents[0]!;
    expect(document).toMatchObject({
      proposedDocumentNumber: "INV-702877", documentFamily: "customer_invoice",
      sourceWorkflow: "main_customer_invoice", proposedAction: "create_draft",
      partyName: party.name, total: 550,
      lineItems: [{ itemCode: "SER9", accountCode: "200", quantity: 2, unitAmount: 250 }],
    });
    snapshots.push({ document: structuredClone(document), contactId: profile?.ContactID ?? null });
    trace.push(`invoice:preflight:${profile ? "matched" : "missing"}`);
    const activeAccount = accountMode !== "inactive" && !(invalidateAccountAfterCreate && profile?.ContactID === CONTACT_ID);
    return [{
      documentNumber: "INV-702877", documentFamily: "customer_invoice", partyName: party.name,
      duplicateState, xeroDocumentId: duplicateState === "found" ? "offline-occupied-invoice" : null,
      status: duplicateState === "found" ? "DRAFT" : null, error: null,
      contactCheck: { found: Boolean(profile), contactId: profile?.ContactID ?? null, count: profile ? 1 : 0, partyName: party.name },
      itemChecks: [{ itemCode: "SER9", found: true, isSold: true, salesAccountCode: accountMode === "mismatch" ? "999" : "200", salesAccountActive: true, salesTaxType: "OUTPUT", nativeDescription: "Loaded Container from <> to <>" }],
      accountChecks: accountMode === "missing" ? [] : [{ accountCode: "200", active: activeAccount }],
    }];
  });
  m.recordPreview.mockResolvedValue({ id: 51, status: "previewed" });
  m.getEvent.mockResolvedValue({ id: 51, status: "previewed", proposedInvoiceNumber: "INV-702877" });
  m.claim.mockResolvedValue(true);
  m.bind.mockImplementation(async () => { trace.push("invoice:bound"); });
  m.completeMain.mockImplementation(async () => { trace.push("invoice:completed"); });
  m.holdMain.mockResolvedValue(undefined);
  m.contactHold.mockResolvedValue(true);
  m.requireLedger.mockResolvedValue(undefined);
  m.reserve.mockImplementation(async () => {
    if (contactEvent) return { kind: "existing", event: { ...contactEvent } };
    contactEvent = { id: 90, status: "reserved" };
    trace.push("contact:reserved");
    return { kind: "reserved", event: { ...contactEvent } };
  });
  m.completeContact.mockImplementation(async (id: number, result: any) => {
    expect(contactEvent).toMatchObject({ id, status: "reserved" });
    contactEvent = { id, status: result.status, xeroContactId: result.xeroContactId };
    trace.push("contact:completed");
  });
  m.holdContact.mockImplementation(async (id: number, _reason: string, uncertain: boolean) => {
    contactEvent = { id, status: uncertain ? "reconciliation_required" : "held" };
    trace.push("contact:held");
  });
  m.prepare.mockImplementation((document: ProposedFinancialDocument, workflowKey: string): FinancialDraftPayload => {
    expect(document.partySourceId).toBe(profile?.ContactID);
    expect(document.partySourceId).toBeTruthy();
    expect(workflowKey).toMatch(/^5x77:main_customer_invoice:[a-f0-9]{64}$/);
    trace.push("invoice:prepare");
    return {
      endpoint: "/Invoices", method: "POST", documentFamily: "customer_invoice",
      documentNumber: document.proposedDocumentNumber!, expectedXeroDocumentId: null,
      idempotencyKey: "0".repeat(64), body: { Invoices: [{
        Type: "ACCREC", Status: "DRAFT", InvoiceNumber: document.proposedDocumentNumber,
        Reference: document.reference, Contact: { ContactID: document.partySourceId! },
        Date: document.issueDate?.toISOString().slice(0, 10),
        DueDate: document.dueDate?.toISOString().slice(0, 10), LineAmountTypes: "Exclusive",
        LineItems: document.lineItems.map(line => ({ ItemCode: line.itemCode,
          Description: line.description, Quantity: line.quantity, UnitAmount: line.unitAmount,
          AccountCode: line.accountCode, TaxType: "OUTPUT" })),
      }] },
    };
  });
  m.bindPayload.mockImplementation((payload: FinancialDraftPayload) => ({ ...payload, idempotencyKey: financialSha256(payload.body) }));
  m.writer.mockImplementation(async () => {
    trace.push("invoice:writer");
    return { outcome: "succeeded", executionId: 91, result: { documentNumber: "INV-702877", xeroDocumentId: "offline-invoice-1" } };
  });
  m.deduction.mockResolvedValue({ status: "disabled", reason: "independently gated", xeroWritesAttempted: 0 });
});

afterEach(() => {
  try {
    // Production catches some transport exceptions and turns them into holds;
    // still fail the test if any unrecognized call was attempted anywhere.
    expect(unexpected).toEqual([]);
    expect(m.forbidden).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    process.env = originalEnv;
    vi.resetModules();
    vi.resetAllMocks();
    records = {}; profile = null; contactEvent = null; trace = []; snapshots = [];
  }
});

describe("offline Main invoice + real current customer source + real v2 creation integration", () => {
  it.each(["organisation", "individual"] as const)("keeps a missing %s profile preview GET-only", async kind => {
    if (kind === "individual") selectIndividual();
    const { previewMainCustomerInvoice } = await services();
    const result = await previewMainCustomerInvoice("5x77");
    const lookup = kind === "organisation" ? [party.name, party.email] : [party.email, party.name];
    expect(result).toMatchObject({ state: "held", noWrites: true, customerContactPlan: {
      status: "would_create", outcome: "would_create_contact", includeEmailOnCreate: true,
      source: { billingKind: kind, customerVtigerId: party.id, name: party.name, email: party.email, invoiceQuoteId: "20x9" },
    } });
    expect(searches()).toEqual(lookup);
    expect(retrieveIds()).toEqual([...factsReadSequence(party), ...sourceReadSequence(party)]);
    expect(m.preflight).toHaveBeenCalledTimes(2);
    expect(contactPosts()).toHaveLength(0);
    expect(m.reserve).not.toHaveBeenCalled();
    expect(m.writer).not.toHaveBeenCalled();
    assertOneAuthentication();
  });

  it.each(["organisation", "individual"] as const)("creates one missing %s contact, reads it back, refreshes full evidence, and writes exactly one Draft", async kind => {
    if (kind === "individual") selectIndividual();
    const { processAutomaticMainCustomerInvoice } = await services();
    const result = await processAutomaticMainCustomerInvoice("5x77");
    expect(result).toMatchObject({ ok: true, status: "drafts_created", eventId: 51,
      invoiceNumber: "INV-702877", xeroInvoiceId: "offline-invoice-1", xeroWritesAttempted: 2,
      mainDeduction: { status: "disabled", xeroWritesAttempted: 0 } });
    const lookup = kind === "organisation" ? [party.name, party.email] : [party.email, party.name];
    expect(searches()).toEqual([...lookup, ...lookup, lookup[0]]);
    expect(contactPosts()).toHaveLength(1);
    expect(m.post).toHaveBeenCalledTimes(2); // one form login, one mocked contact write
    expect(m.run).toHaveBeenCalledTimes(1);
    expect(m.reserve).toHaveBeenCalledTimes(1);
    expect(m.reserve).toHaveBeenCalledWith(expect.objectContaining({
      workflowFamily: "customer_contact_v2", source: expect.objectContaining({
        customerVtigerId: party.id, customerKind: kind === "organisation" ? "organisation" : "contact",
        name: party.name, email: party.email, sourceSnapshotHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }), sourceSummary: expect.objectContaining({ billingKind: kind, linkedAccountId: kind === "organisation" ? "4x2" : null, linkedContactId: "4x3" }),
      lookupSummary: { lookupOrder: kind === "organisation" ? ["name", "email"] : ["email", "name"], nameMatchCount: 0, emailMatchCount: 0, includeEmailOnCreate: true },
    }));
    expect(m.completeContact).toHaveBeenCalledWith(90, expect.objectContaining({ status: "created", xeroContactId: CONTACT_ID, outcome: "created_contact" }));
    expect(m.holdContact).not.toHaveBeenCalled();
    expect(retrieveIds()).toEqual([
      ...factsReadSequence(party), ...sourceReadSequence(party), // initial Main and contact preview
      ...sourceReadSequence(party), // current source before contact reservation/write
      ...factsReadSequence(party), ...sourceReadSequence(party), // all sources fetched after creation
    ]);
    if (kind === "organisation") expect(retrieveIds()).not.toContain("4x3");
    else expect(retrieveIds()).not.toContain("4x2");
    const readbackIndex = trace.indexOf("xero:readback");
    expect(readbackIndex).toBeGreaterThan(trace.indexOf("xero:contact-post"));
    expect(trace.slice(readbackIndex + 1).filter(step => step.startsWith("vtiger:retrieve:")))
      .toEqual([...factsReadSequence(party), ...sourceReadSequence(party)].map(id => `vtiger:retrieve:${id}`));
    expect(m.boundedGet.mock.calls.filter(([, name]) => name === "GET customer-contact-v2-readback")).toHaveLength(1);
    expect(m.get.mock.calls.filter(([url, config]) => url === VTIGER_ENDPOINT && config.params.operation === "describe")).toHaveLength(2);
    expect(m.preflight).toHaveBeenCalledTimes(4);
    expect(snapshots.map(item => item.contactId)).toEqual([null, null, CONTACT_ID, CONTACT_ID]);
    expect(snapshots.map(item => item.document.lineItems[0]!.description)).toEqual([
      "Pending current Xero SER9 route description", "Loaded Container from Origin to Destination",
      "Pending current Xero SER9 route description", "Loaded Container from Origin to Destination",
    ]);
    expect(snapshots[3]!.document.partySourceId).toBe(CONTACT_ID);
    expect(trace.indexOf("invoice:writer")).toBeGreaterThan(trace.lastIndexOf("invoice:preflight:matched"));
    expect(trace.indexOf("invoice:writer")).toBeGreaterThan(trace.indexOf("contact:completed"));
    expect(m.writer).toHaveBeenCalledTimes(1);
    expect(m.prepare).toHaveBeenCalledTimes(1);
    expect(m.claim).toHaveBeenCalledTimes(1);
    expect(m.bind).toHaveBeenCalledTimes(1);
    const binding = m.bind.mock.calls[0]![0];
    expect(binding).toMatchObject({ eventId: 51, releaseKey: "MAIN-offline-integration", token: expect.stringMatching(/^[a-f0-9-]{36}$/i) });
    expect(m.writer).toHaveBeenCalledWith(expect.objectContaining({
      workflowType: "main_customer_invoice", proposedAction: "create_draft",
      authorisation: expect.objectContaining({ mainCustomerInvoiceAutomaticEventId: 51, mainCustomerInvoiceToken: binding.token }),
      payload: expect.objectContaining({ endpoint: "/Invoices", method: "POST", idempotencyKey: binding.payload.idempotencyKey,
        body: { Invoices: [{ Type: "ACCREC", Status: "DRAFT", CurrencyCode: "AUD", InvoiceNumber: "INV-702877",
          Reference: "Q-702877", Contact: { ContactID: CONTACT_ID }, Date: "2026-10-12", DueDate: "2026-10-14",
          LineAmountTypes: "Exclusive", LineItems: [{ ItemCode: "SER9", Description: "Loaded Container from Origin to Destination",
            Quantity: 2, UnitAmount: 250, AccountCode: "200", TaxType: "OUTPUT" }] }] } }),
      expectedDraftDocument: expect.objectContaining({ partySourceId: CONTACT_ID, subtotal: 500, taxAmount: 50, total: 550 }),
    }));
    expect(binding.payload.idempotencyKey).toMatch(/^[a-f0-9]{64}$/);
    expect(m.completeMain).toHaveBeenCalledWith({ eventId: 51, executionId: 91, xeroInvoiceId: "offline-invoice-1" });
    expect(m.deduction).toHaveBeenCalledWith("5x77", "main");
    expect(trace.indexOf("invoice:completed")).toBeGreaterThan(trace.indexOf("invoice:writer"));
    assertOneAuthentication();
  });

  it.each(["organisation", "individual"] as const)("reuses an existing active %s profile without contact creation", async kind => {
    if (kind === "individual") selectIndividual();
    setExistingActiveProfile();
    const { processAutomaticMainCustomerInvoice } = await services();
    const result = await processAutomaticMainCustomerInvoice("5x77");
    expect(result).toMatchObject({ ok: true, status: "drafts_created", xeroWritesAttempted: 1 });
    expect(searches()).toEqual([kind === "organisation" ? party.name : party.email]);
    expect(contactPosts()).toHaveLength(0);
    expect(m.requireLedger).not.toHaveBeenCalled();
    expect(m.reserve).not.toHaveBeenCalled();
    expect(m.run).not.toHaveBeenCalled();
    expect(m.preflight).toHaveBeenCalledTimes(2);
    expect(m.writer).toHaveBeenCalledTimes(1);
    expect(m.writer.mock.calls[0]![0].expectedDraftDocument.partySourceId).toBe("offline-existing-customer");
    expect(retrieveIds()).toEqual([...factsReadSequence(party), ...sourceReadSequence(party)]);
    assertOneAuthentication();
  });

  it("does not create a missing customer or invoice when the independent automatic-contact gate is false", async () => {
    process.env.FINANCIAL_CUSTOMER_CONTACT_AUTOMATIC_ENABLED = "false";
    const { processAutomaticMainCustomerInvoice } = await services();
    expect(await processAutomaticMainCustomerInvoice("5x77"))
      .toMatchObject({ ok: false, status: "held", xeroWritesAttempted: 0,
        stage: "customer_profile_creation", customerContactEventId: null,
        warning: "Automatic Xero customer-profile creation is disabled; both the customer-contact v2 and automatic-creation release gates must be enabled." });
    expect(m.contactHold).toHaveBeenCalledWith({ eventId: 51,
      sourceSnapshotHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      reason: "Automatic Xero customer-profile creation is disabled; both the customer-contact v2 and automatic-creation release gates must be enabled." });
    expect(searches()).toEqual([party.name, party.email]);
    expect(contactPosts()).toHaveLength(0);
    expect(m.requireLedger).not.toHaveBeenCalled();
    expect(m.reserve).not.toHaveBeenCalled();
    expect(m.claim).not.toHaveBeenCalled();
    expect(m.writer).not.toHaveBeenCalled();
    expect(m.preflight).toHaveBeenCalledTimes(2);
    expect(retrieveIds()).toEqual([...factsReadSequence(party), ...sourceReadSequence(party)]);
    assertOneAuthentication();
  });

  it("does not create a missing customer when the exact invoice already exists", async () => {
    duplicateState = "found";
    const { processAutomaticMainCustomerInvoice } = await services();
    expect(await processAutomaticMainCustomerInvoice("5x77"))
      .toMatchObject({ ok: false, status: "held", xeroWritesAttempted: 0, warning: expect.stringContaining("Exact Xero invoice INV-702877") });
    expect(m.recordPreview).toHaveBeenCalledWith(expect.objectContaining({ status: "held", holdReason: expect.stringContaining("Exact Xero invoice") }));
    expect(contactPosts()).toHaveLength(0);
    expect(m.reserve).not.toHaveBeenCalled();
    expect(m.claim).not.toHaveBeenCalled();
    expect(m.writer).not.toHaveBeenCalled();
    expect(m.preflight).toHaveBeenCalledTimes(2);
    assertOneAuthentication();
  });

  it.each(["inactive", "missing", "mismatch"] as const)("holds a missing customer with current sales-account state %s before customer creation", async mode => {
    accountMode = mode;
    const { processAutomaticMainCustomerInvoice } = await services();
    const result = await processAutomaticMainCustomerInvoice("5x77");
    expect(result).toMatchObject({ ok: false, status: "held", xeroWritesAttempted: 0,
      warning: expect.stringMatching(mode === "mismatch" ? /sales item SER9/ : /sales account/) });
    expect(m.recordPreview).toHaveBeenCalledWith(expect.objectContaining({ status: "held" }));
    expect(contactPosts()).toHaveLength(0);
    expect(m.reserve).not.toHaveBeenCalled();
    expect(m.claim).not.toHaveBeenCalled();
    expect(m.writer).not.toHaveBeenCalled();
    expect(m.preflight).toHaveBeenCalledTimes(mode === "mismatch" ? 1 : 2);
    expect(snapshots.every(snapshot => snapshot.contactId === null)).toBe(true);
    assertOneAuthentication();
  });

  it.each([502, 503, 504])("attempts an uncertain HTTP %i contact POST only once and never writes an invoice", async status => {
    postStatus = status;
    const { processAutomaticMainCustomerInvoice } = await services();
    expect(await processAutomaticMainCustomerInvoice("5x77"))
      .toMatchObject({ ok: false, status: "reconciliation_required", xeroWritesAttempted: 1,
        stage: "customer_profile_creation", customerContactEventId: 90,
        warning: "Xero customer contact creation has an uncertain gateway result; reconcile before any retry." });
    expect(m.contactHold).toHaveBeenCalledWith({ eventId: 51,
      sourceSnapshotHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      reason: "Xero customer contact creation has an uncertain gateway result; reconcile before any retry." });
    expect(contactPosts()).toHaveLength(1);
    expect(m.run).toHaveBeenCalledTimes(1);
    expect(m.run).toHaveBeenCalledWith(AUTH, "POST customer-contact-v2", expect.any(Function), { retryTransientGatewayFailures: false });
    expect(searches()).toEqual([party.name, party.email, party.name, party.email]);
    expect(m.holdContact).toHaveBeenCalledWith(90, expect.stringMatching(/uncertain gateway/), true, "held_xero_contact_creation_failed");
    expect(contactEvent).toMatchObject({ status: "reconciliation_required" });
    expect(m.completeContact).not.toHaveBeenCalled();
    expect(m.boundedGet.mock.calls.some(([, name]) => name === "GET customer-contact-v2-readback")).toBe(false);
    expect(m.preflight).toHaveBeenCalledTimes(2);
    expect(m.claim).not.toHaveBeenCalled();
    expect(m.prepare).not.toHaveBeenCalled();
    expect(m.writer).not.toHaveBeenCalled();
    expect(m.completeMain).not.toHaveBeenCalled();
    expect(m.deduction).not.toHaveBeenCalled();
    expect(retrieveIds()).toEqual([...factsReadSequence(party), ...sourceReadSequence(party), ...sourceReadSequence(party)]);
    assertOneAuthentication();
  });

  it("honors refreshed invoice-account evidence after a successful contact POST/readback instead of writing a stale Draft", async () => {
    invalidateAccountAfterCreate = true;
    const { processAutomaticMainCustomerInvoice } = await services();
    expect(await processAutomaticMainCustomerInvoice("5x77"))
      .toMatchObject({ ok: false, status: "held", xeroWritesAttempted: 1, warning: expect.stringContaining("sales account") });
    expect(contactPosts()).toHaveLength(1);
    expect(m.completeContact).toHaveBeenCalledTimes(1);
    expect(m.preflight).toHaveBeenCalledTimes(4);
    expect(snapshots.map(snapshot => snapshot.contactId)).toEqual([null, null, CONTACT_ID, CONTACT_ID]);
    expect(m.claim).not.toHaveBeenCalled();
    expect(m.prepare).not.toHaveBeenCalled();
    expect(m.writer).not.toHaveBeenCalled();
    expect(m.completeMain).not.toHaveBeenCalled();
    expect(retrieveIds()).toEqual([...factsReadSequence(party), ...sourceReadSequence(party), ...sourceReadSequence(party), ...factsReadSequence(party), ...sourceReadSequence(party)]);
    assertOneAuthentication();
  });

  it.each(["main_source", "customer_source", "contact_id"] as const)("requires exact refreshed %s evidence after successful contact readback", async mutation => {
    postReadbackMutation = mutation;
    const { processAutomaticMainCustomerInvoice } = await services();
    const result = await processAutomaticMainCustomerInvoice("5x77");
    const reason = "Current Deal, Quote or Xero customer changed after customer-profile resolution; the exact resolved ContactID and source must agree before any invoice Draft.";
    expect(result).toMatchObject({ ok: false, status: "held", xeroWritesAttempted: 1,
      stage: "post_contact_invoice_preflight", customerContactEventId: 90, warning: reason });
    expect(m.contactHold).toHaveBeenCalledWith({ eventId: 51,
      sourceSnapshotHash: expect.stringMatching(/^[a-f0-9]{64}$/), reason });
    expect(contactPosts()).toHaveLength(1);
    expect(m.completeContact).toHaveBeenCalledWith(90, expect.objectContaining({ status: "created", xeroContactId: CONTACT_ID }));
    expect(m.preflight).toHaveBeenCalledTimes(4);
    const initial = m.recordPreview.mock.calls[0]![0];
    const refreshed = m.recordPreview.mock.calls[1]![0];
    if (mutation === "main_source") expect(refreshed.sourceSnapshotHash).not.toBe(initial.sourceSnapshotHash);
    else expect(refreshed.sourceSnapshotHash).toBe(initial.sourceSnapshotHash);
    expect(snapshots[3]!.contactId).toBe(mutation === "contact_id" ? "offline-changed-contact" : CONTACT_ID);
    expect(m.claim).not.toHaveBeenCalled();
    expect(m.prepare).not.toHaveBeenCalled();
    expect(m.writer).not.toHaveBeenCalled();
    expect(m.completeMain).not.toHaveBeenCalled();
    assertOneAuthentication();
  });

  it("retains one contact attempt and the exact post-contact stage when a fresh VTiger source GET fails", async () => {
    postReadbackMutation = "source_exception";
    const { processAutomaticMainCustomerInvoice } = await services();
    expect(await processAutomaticMainCustomerInvoice("5x77"))
      .toMatchObject({ ok: false, status: "held", xeroWritesAttempted: 1,
        stage: "post_contact_invoice_preflight", customerContactEventId: 90,
        warning: "Customer profile was resolved, but invoice source revalidation failed: offline current Deal read unavailable" });
    expect(contactPosts()).toHaveLength(1);
    expect(m.completeContact).toHaveBeenCalledTimes(1);
    expect(trace).toContain("xero:readback");
    expect(m.preflight).toHaveBeenCalledTimes(2);
    expect(retrieveIds()).toEqual([...factsReadSequence(party), ...sourceReadSequence(party), ...sourceReadSequence(party), "5x77"]);
    expect(m.claim).not.toHaveBeenCalled();
    expect(m.prepare).not.toHaveBeenCalled();
    expect(m.writer).not.toHaveBeenCalled();
    expect(m.completeMain).not.toHaveBeenCalled();
    expect(m.deduction).not.toHaveBeenCalled();
    assertOneAuthentication();
  });
});
