import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ policy: vi.fn(), source: vi.fn(), xero: vi.fn(), preview: vi.fn(), claim: vi.fn(), entries: vi.fn(), event: vi.fn(), reserve: vi.fn(), pair: vi.fn(), customerSource: vi.fn(), customerPlan: vi.fn(), customerCreate: vi.fn() }));
vi.mock("./financialWorkflowDb", () => ({ getFinancialWorkflowConfig: vi.fn() }));
vi.mock("./financialWarrantyAvisoRelease", async original => ({ ...(await original<any>()), getWarrantyReleasePolicy: m.policy }));
vi.mock("./financialWarrantyAvisoSource", () => ({ readWarrantyFacts: m.source }));
vi.mock("./financialWarrantyAvisoXero", () => ({ readWarrantyXeroEvidence: m.xero }));
vi.mock("./financialWarrantyAvisoDb", () => ({ recordWarrantyPreview: m.preview, getWarrantyDealClaim: m.claim, getWarrantyExecutionEntries: m.entries, getWarrantyEvent: m.event, reserveWarranty: m.reserve }));
vi.mock("./financialWarrantyAvisoWriter", () => ({ executeWarrantyPair: m.pair }));
vi.mock("./financialCustomerContactSourceV2", () => ({ readCurrentCustomerContactResolution: m.customerSource }));
vi.mock("./financialCustomerContactServiceV2", () => ({ previewCustomerContactResolution: m.customerPlan, executeCustomerContactCreationV2: m.customerCreate }));
import { warrantyFixture } from "./financialWarrantyAvisoFixtures";
import { resolveWarrantyRelease } from "./financialWarrantyAvisoRelease";
import { getWarrantyReadiness, previewWarrantyAviso, processAutomaticWarrantyAviso } from "./financialWarrantyAvisoService";

let f: ReturnType<typeof warrantyFixture>;
beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-11T00:00:00Z"));
  vi.stubEnv("FINANCIAL_WARRANTY_AUTOMATIC_ENABLED", "");
  f = warrantyFixture();
  m.policy.mockImplementation(async () => f.policy); m.source.mockImplementation(async () => f.facts); m.xero.mockImplementation(async () => f.evidence);
  m.preview.mockResolvedValue({ id: 9 }); m.claim.mockResolvedValue(null); m.entries.mockResolvedValue([]);
  m.event.mockResolvedValue({ ...f.reservation, id: 9, status: "previewed" }); m.reserve.mockResolvedValue(f.reservation);
  m.pair.mockResolvedValue({ ok: true, status: "drafts_created" });
  m.customerSource.mockResolvedValue({ dealId: "5x77", name: f.facts.customerName });
  m.customerPlan.mockResolvedValue({ status: "matched", contactId: f.evidence.customer.ContactID, holdReason: null });
  m.customerCreate.mockResolvedValue({ status: "matched", contactId: f.evidence.customer.ContactID, contactWritesAttempted: 0, holdReason: null });
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });
const noExecution = () => { expect(m.reserve).not.toHaveBeenCalled(); expect(m.pair).not.toHaveBeenCalled(); };

describe("Warranty factual administrator previews and default-off readiness", () => {
  it("absent actual source configuration returns factual hold/evidence list and never reads Xero", async () => {
    m.policy.mockResolvedValue(resolveWarrantyRelease(null));
    const facts = { ...f.facts, dealNumber: "", mapping: null, configurationRequired: ["Actual Added Services metadata and one approved WAR mapping"], holdReason: "Warranty source configuration absent/unproven; no guessed premium." };
    m.source.mockResolvedValue(facts);
    expect(await previewWarrantyAviso("5x77")).toMatchObject({ state: "held", holdReason: facts.holdReason, facts, evidence: null, plan: null, noWrites: true });
    expect(m.source).toHaveBeenCalledWith("5x77", null);
    expect(m.preview).toHaveBeenCalledWith(facts, null, null, facts.holdReason);
    expect(m.xero).not.toHaveBeenCalled(); noExecution();
  });
  it("missing config cannot accidentally appear previewed if source dependency omits a hold", async () => {
    m.policy.mockResolvedValue(resolveWarrantyRelease(null));
    expect(await previewWarrantyAviso("5x77")).toMatchObject({ state: "held", holdReason: expect.stringMatching(/absent\/unproven/), evidence: null, plan: null });
    expect(m.xero).not.toHaveBeenCalled(); noExecution();
  });
  it("unavailable current metadata creates factual immutable hold without Xero", async () => {
    m.source.mockRejectedValue(new Error("Authenticated Potentials metadata unavailable"));
    const result = await previewWarrantyAviso("5x77");
    expect(result).toMatchObject({ state: "held", holdReason: "Authenticated Potentials metadata unavailable", evidence: null, plan: null, noWrites: true });
    expect(result.facts.configurationRequired.length).toBeGreaterThan(0);
    expect(m.preview).toHaveBeenCalledTimes(1); expect(m.xero).not.toHaveBeenCalled(); noExecution();
  });
  it("pre-existing lifetime AP claim stays held, never adopts or repeats documents", async () => {
    m.claim.mockResolvedValue({ claimKey: "warranty:D77", status: "reserved", executionGroup: "existing-group" });
    const result = await previewWarrantyAviso("5x77");
    expect(result).toMatchObject({ state: "held", holdReason: expect.stringMatching(/already has an immutable AP warranty claim/), noWrites: true });
    expect(m.claim).toHaveBeenCalledWith("D77"); noExecution();
  });
  it.each(["sourceMappingsHash", "addedServicesMappingHash", "xeroConfigurationHash", "avisoContactId"])("unapproved exact %s remains a preview hold", async key => {
    m.policy.mockResolvedValue({ ...f.policy, [key]: "unapproved" });
    expect(await previewWarrantyAviso("5x77")).toMatchObject({ state: "held", holdReason: expect.stringMatching(/not explicitly approved/), noWrites: true });
    noExecution();
  });
  it("default-off readiness is a no-write contract and lists unknown actual configuration", async () => {
    m.policy.mockResolvedValue(resolveWarrantyRelease(null));
    const readiness = await getWarrantyReadiness();
    expect(readiness).toMatchObject({ flagEnabled: false, writerEnabled: false, noWrites: true, holdReason: expect.stringMatching(/disabled/), migrationApplication: expect.stringMatching(/migration 0045 is applied/) });
    expect(readiness.configurationRequired.length).toBeGreaterThan(0);
    expect(m.source).not.toHaveBeenCalled(); expect(m.xero).not.toHaveBeenCalled(); expect(m.preview).not.toHaveBeenCalled(); noExecution();
  });
});

describe("Warranty automatic service held boundaries", () => {
  it("default off fails before source, Xero or ledger paths", async () => {
    await expect(processAutomaticWarrantyAviso("5x77")).rejects.toThrow(/disabled/);
    expect(m.source).not.toHaveBeenCalled(); expect(m.xero).not.toHaveBeenCalled(); expect(m.preview).not.toHaveBeenCalled(); noExecution();
  });
  it("source pre-cutover remains held with zero writes and no reservation", async () => {
    vi.stubEnv("FINANCIAL_WARRANTY_AUTOMATIC_ENABLED", "true");
    m.source.mockResolvedValue({ ...f.facts, sourceModifiedAt: "2026-09-29T23:59:59Z" });
    expect(await processAutomaticWarrantyAviso("5x77")).toMatchObject({ ok: false, status: "held", xeroWritesAttempted: 0, warning: expect.stringMatching(/predates approved New Events cutover/) });
    expect(m.event).not.toHaveBeenCalled(); noExecution();
  });
  it.each(["reserved", "main_receipt", "reconciliation_required", "drafts_created"])("pre-existing %s claim never re-executes", async status => {
    vi.stubEnv("FINANCIAL_WARRANTY_AUTOMATIC_ENABLED", "true");
    m.claim.mockResolvedValue({ executionGroup: "existing-group", status }); m.entries.mockResolvedValue([{ status }]);
    expect(await processAutomaticWarrantyAviso("5x77")).toMatchObject({ ok: false, status: status === "drafts_created" ? "duplicate_replay" : "reconciliation_required", xeroWritesAttempted: 0 });
    noExecution();
  });
  it("source hold skips all Xero and no automatic reservation occurs", async () => {
    vi.stubEnv("FINANCIAL_WARRANTY_AUTOMATIC_ENABLED", "true"); m.source.mockResolvedValue({ ...f.facts, holdReason: "Current Added Services unsupported" });
    expect(await processAutomaticWarrantyAviso("5x77")).toMatchObject({ status: "held", xeroWritesAttempted: 0 });
    expect(m.xero).not.toHaveBeenCalled(); noExecution();
  });
  it("claim reservation collision is held without retrying writer", async () => {
    vi.stubEnv("FINANCIAL_WARRANTY_AUTOMATIC_ENABLED", "true"); m.reserve.mockRejectedValue(new Error("ER_DUP_ENTRY"));
    expect(await processAutomaticWarrantyAviso("5x77")).toMatchObject({ status: "held", xeroWritesAttempted: 0, warning: expect.stringMatching(/exclusively reserved/) });
    expect(m.reserve).toHaveBeenCalledTimes(1); expect(m.pair).not.toHaveBeenCalled();
  });
  it("creates a missing customer only through v2, then refreshes the exact Warranty preflight before the Draft pair", async () => {
    vi.stubEnv("FINANCIAL_WARRANTY_AUTOMATIC_ENABLED", "true");
    const wouldCreate = { status: "would_create", contactId: null, holdReason: null, source: { dealId: "5x77" } };
    const matched = { status: "matched", contactId: "customer-id", holdReason: null, source: { dealId: "5x77" } };
    m.customerPlan.mockResolvedValueOnce(wouldCreate).mockResolvedValueOnce(matched);
    m.customerCreate.mockResolvedValue({ ...matched, status: "created", contactWritesAttempted: 1 });
    m.pair.mockResolvedValue({ ok: true, status: "drafts_created", eventId: 9, xeroWritesAttempted: 2 });
    expect(await processAutomaticWarrantyAviso("5x77")).toMatchObject({ ok: true, status: "drafts_created", contactWritesAttempted: 1, xeroWritesAttempted: 3 });
    expect(m.customerCreate).toHaveBeenCalledWith(wouldCreate);
    expect(m.xero).toHaveBeenCalledTimes(1); expect(m.xero).toHaveBeenCalledWith(f.facts, { customerContactId: "customer-id" });
    expect(m.reserve).toHaveBeenCalledTimes(1); expect(m.pair).toHaveBeenCalledTimes(1);
  });
});
