import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";
const m = vi.hoisted(() => ({ preview: vi.fn(), approve: vi.fn(), list: vi.fn(), enabled: vi.fn(), exact: vi.fn() }));
vi.mock("./financialForHireManualHandoverService", () => ({ previewManualForHireHandover: m.preview, enrollManualForHireHandover: m.approve }));
vi.mock("./financialForHireManualHandoverDb", () => ({ listManualForHireHandovers: m.list, isManualForHireHandoverEnabled: m.enabled }));
vi.mock("./vtigerFinancialCandidateService", () => ({ findExactFinancialCandidate: m.exact }));
// Intentionally do not mock _core/trpc: anonymous and disabled-account checks are real.
import { manualForHireHandoverRouter } from "./manualForHireHandoverRouter";
function context(user: Record<string, any> | null = { role: "admin", id: 7, status: "active" }): TrpcContext {
  return { user: user ? { openId: "offline", name: "Offline Accounts", email: "test@example.invalid", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(), ...user } as any : null, req: { headers: {} } as any, res: {} as any };
}
const input = () => ({ exactContainerControl: "C1929", manualPoNumber: "HC1929", coveredThrough: "2026-12-13", effectiveFrom: "2026-12-14", confirmedLatestCoverage: true as const, confirmedNoOtherFutureCoverage: true as const, confirmedCoveredThrough: true as const });
const approval = () => ({ ...input(), expectedPlanHash: "a".repeat(64), manualCreationStopped: true as const, acknowledgement: "FUTURE_ONLY_MANUAL_PO_HANDOVER" as const });
function noLookupOrApproval() { expect(m.exact).not.toHaveBeenCalled(); expect(m.preview).not.toHaveBeenCalled(); expect(m.approve).not.toHaveBeenCalled(); }
beforeEach(() => {
  vi.resetAllMocks(); m.enabled.mockReturnValue(true); m.list.mockResolvedValue([]);
  m.exact.mockResolvedValue({ outcome: "found", candidates: [{ recordId: "24x1929", businessNumber: "C1929" }], message: "exact match" });
  m.preview.mockResolvedValue({ state: "ready", plan: { containerControlNumber: "C1929", planHash: "a".repeat(64) }, proposal: {}, holdReason: null, noFinancialWrites: true, enrollmentEnabled: true, evidence: { tenantId: "secret", coverageAttestation: { reviewedBy: 7 } } });
  m.approve.mockResolvedValue({ id: 9, status: "approved" });
});

describe("standalone manual hire Accounts-admin router", () => {
  it("anonymous, nonadmin, disabled and invalid-id accounts are blocked by protected auth before lookup, readiness or ledger", async () => {
    for (const user of [null, { role: "user", id: 7, status: "active" }, { role: "admin", id: 7, status: "disabled" }, { role: "admin", id: 0, status: "active" }]) {
      vi.clearAllMocks(); const c = manualForHireHandoverRouter.createCaller(context(user));
      for (const fn of [() => c.readiness(), () => c.list(), () => c.preview(input()), () => c.approve(approval())]) await expect(fn()).rejects.toMatchObject({ code: user ? "FORBIDDEN" : "UNAUTHORIZED" });
      noLookupOrApproval(); expect(m.enabled).not.toHaveBeenCalled(); expect(m.list).not.toHaveBeenCalled();
    }
  });
  it("default-off approval rejects before exact C lookup/enrollment while read-only preview remains available", async () => {
    m.enabled.mockReturnValue(false); const c = manualForHireHandoverRouter.createCaller(context());
    await expect(c.approve(approval())).rejects.toMatchObject({ code: "PRECONDITION_FAILED" }); noLookupOrApproval();
    expect(await c.readiness()).toEqual({ implementationReady: true, enrollmentEnabled: false, recurringActivationSeparate: true, accountsCoverageConfirmationRequired: true });
    await c.preview(input()); expect(m.preview).toHaveBeenCalledTimes(1); expect(m.approve).not.toHaveBeenCalled();
  });
  it("exact C lookup has one found outcome and forwards canonical identity plus ctx reviewer, stripping private evidence", async () => {
    const c = manualForHireHandoverRouter.createCaller(context());
    const result = await c.preview({ ...input(), exactContainerControl: " c1929 ", manualPoNumber: " hc1929 " });
    expect(m.exact).toHaveBeenCalledTimes(1);
    expect(m.exact).toHaveBeenCalledWith({ sourceCategory: "container_control", businessNumber: "C1929" });
    expect(m.preview).toHaveBeenCalledTimes(1);
    expect(m.preview).toHaveBeenCalledWith(expect.objectContaining({ recordId: "24x1929", expectedControlNumber: "C1929", manualPoNumber: "HC1929", reviewedBy: 7, confirmedLatestCoverage: true, confirmedNoOtherFutureCoverage: true }));
    expect(result).not.toHaveProperty("evidence"); expect(result).toMatchObject({ state: "ready", noFinancialWrites: true });
  });
  it("not-found/ambiguous/incomplete lookups and multiple/zero found candidates hold without service approval", async () => {
    const c = manualForHireHandoverRouter.createCaller(context());
    for (const lookup of [{ outcome: "not_found", candidates: [] }, { outcome: "ambiguous", candidates: [{ recordId: "24x1929" }, { recordId: "24x1930" }] }, { outcome: "held", candidates: [{ recordId: "24x1929" }] }, { outcome: "found", candidates: [] }, { outcome: "found", candidates: [{ recordId: "24x1929" }, { recordId: "24x1930" }] }]) {
      m.exact.mockResolvedValue({ ...lookup, message: "held exact lookup" });
      await expect(c.preview(input())).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
      await expect(c.approve(approval())).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    }
    expect(m.preview).not.toHaveBeenCalled(); expect(m.approve).not.toHaveBeenCalled();
  });
  it("exact VTiger ID bypasses lookup, server ctx overrides forged reviewer/approver/record/hash extras", async () => {
    const c = manualForHireHandoverRouter.createCaller(context());
    const forged = { ...approval(), exactContainerControl: "24X1929", reviewedBy: 999, approvedBy: 999, recordId: "24x9999", expectedControlNumber: "C9999", coverageAttestation: { reviewedBy: 999 }, complete: true };
    await c.preview(forged as any); await c.approve(forged as any); expect(m.exact).not.toHaveBeenCalled();
    expect(m.preview).toHaveBeenCalledWith(expect.objectContaining({ recordId: "24x1929", reviewedBy: 7, expectedControlNumber: undefined }));
    expect(m.approve).toHaveBeenCalledWith(expect.objectContaining({ recordId: "24x1929", reviewedBy: 7, approvedBy: 7, expectedControlNumber: undefined, expectedPlanHash: "a".repeat(64), manualCreationStopped: true, acknowledgement: "FUTURE_ONLY_MANUAL_PO_HANDOVER" }));
    for (const forwarded of [m.preview.mock.calls[0][0], m.approve.mock.calls[0][0]]) { expect(forwarded).not.toHaveProperty("coverageAttestation"); expect(forwarded).not.toHaveProperty("complete"); }
  });
  it("C-number changing after lookup is held; approval passes exact expected C to the fresh service check", async () => {
    const c = manualForHireHandoverRouter.createCaller(context());
    m.preview.mockResolvedValue({ state: "ready", plan: { containerControlNumber: "C1930" }, evidence: {}, noFinancialWrites: true });
    await expect(c.preview(input())).rejects.toMatchObject({ code: "PRECONDITION_FAILED" }); expect(m.approve).not.toHaveBeenCalled();
    m.approve.mockRejectedValue(new Error("Current Container Control number changed after the exact lookup; no handover was saved."));
    await expect(c.approve(approval())).rejects.toThrow(/number changed/i);
    expect(m.approve).toHaveBeenCalledWith(expect.objectContaining({ recordId: "24x1929", expectedControlNumber: "C1929", reviewedBy: 7, approvedBy: 7 }));
  });
  it("both separate coverage assertions and stop/acknowledgement/hash must be exact literals before lookup or approval", async () => {
    const c = manualForHireHandoverRouter.createCaller(context());
    for (const patch of [{ confirmedLatestCoverage: undefined }, { confirmedLatestCoverage: false }, { confirmedLatestCoverage: "true" }, { confirmedNoOtherFutureCoverage: undefined }, { confirmedNoOtherFutureCoverage: false }, { confirmedNoOtherFutureCoverage: "true" }, { coverageReviewed: true, confirmedLatestCoverage: undefined, confirmedNoOtherFutureCoverage: undefined }, { manualCreationStopped: false }, { manualCreationStopped: undefined }, { acknowledgement: "YES" }, { acknowledgement: undefined }, { expectedPlanHash: "a".repeat(63) }, { expectedPlanHash: "A".repeat(64) }, { exactContainerControl: "browse-all" }, { manualPoNumber: "HC1929-01" }]) await expect(c.approve({ ...approval(), ...patch } as any)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    noLookupOrApproval();
    await c.preview({ ...input(), confirmedLatestCoverage: false, confirmedNoOtherFutureCoverage: false }); expect(m.preview).toHaveBeenCalledWith(expect.objectContaining({ confirmedLatestCoverage: false, confirmedNoOtherFutureCoverage: false }));
  });
  it("accepts the existing legacy first extension HC1920-1 without treating it as an initial receipt", async () => {
    const c = manualForHireHandoverRouter.createCaller(context());
    const values = { ...approval(), exactContainerControl: "79x489745", manualPoNumber: "HC1920-1" };
    await c.preview(values); await c.approve(values);
    expect(m.approve).toHaveBeenCalledWith(expect.objectContaining({ recordId: "79x489745", manualPoNumber: "HC1920-1", confirmedCoveredThrough: true, reviewedBy: 7 }));
    expect(m.exact).not.toHaveBeenCalled();
  });
  it("requires the separate literal coverage-date attestation before any approval lookup", async () => {
    const c = manualForHireHandoverRouter.createCaller(context());
    for (const value of [undefined, false, "true", 1]) await expect(c.approve({ ...approval(), confirmedCoveredThrough: value } as any)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    noLookupOrApproval();
  });
  it("rejects zero, leading-zero, negative, decimal and noncanonical suffixes before source lookup", async () => {
    const c = manualForHireHandoverRouter.createCaller(context());
    for (const number of ["HC1920-0", "HC1920-01", "HC1920--1", "HC1920-1.5", "HC01920-1"]) await expect(c.preview({ ...input(), manualPoNumber: number })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    noLookupOrApproval();
  });
  it("forwards explicit historical line 0/net139.50 and strips a forged reviewer without substituting future net135", async () => {
    const c = manualForHireHandoverRouter.createCaller(context());
    await c.approve({ ...approval(), exactContainerControl: "79x489745", manualPoNumber: "HC1920-1", lumpSumManual: { confirmed: true, lineIndex: 0, amount: 139.5, reviewedBy: 999 } } as any);
    expect(m.approve).toHaveBeenCalledWith(expect.objectContaining({ reviewedBy: 7, approvedBy: 7, lumpSumManual: { confirmed: true, lineIndex: 0, amount: 139.5 } }));
    expect(m.approve.mock.calls[0][0].lumpSumManual).not.toHaveProperty("reviewedBy");
  });
  it("invalid legacy acknowledgements fail schema before any source lookup or approval", async () => {
    const c = manualForHireHandoverRouter.createCaller(context());
    for (const lumpSumManual of [
      { confirmed: false, lineIndex: 0, amount: 139.5 }, { confirmed: "true", lineIndex: 0, amount: 139.5 },
      { confirmed: true, lineIndex: -1, amount: 139.5 }, { confirmed: true, lineIndex: 0.5, amount: 139.5 },
      { confirmed: true, lineIndex: 200, amount: 139.5 }, { confirmed: true, lineIndex: 0, amount: 0 },
      { confirmed: true, lineIndex: 0, amount: -139.5 }, { confirmed: true, lineIndex: 0, amount: "139.50" },
    ]) await expect(c.approve({ ...approval(), lumpSumManual } as any)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    noLookupOrApproval();
  });
  it("list is bounded and exposes audit summaries rather than stored evidence/tokens, readiness cannot activate billing", async () => {
    const c = manualForHireHandoverRouter.createCaller(context());
    m.list.mockResolvedValue([{ id: 9, containerControlNumber: "C1929", manualPoNumber: "HC1929", coveredThrough: "2026-12-13", nextBillingDate: "2026-12-14", status: "approved", planHash: "a".repeat(64), approvedAt: new Date("2026-11-15"), holdReason: null, processingToken: "secret", evidence: { tenantId: "secret" }, plan: { secret: true } }]);
    const rows = await c.list({ limit: 25 }); expect(m.list).toHaveBeenCalledWith(25);
    for (const secret of ["processingToken", "evidence", "plan"]) expect(rows[0]).not.toHaveProperty(secret);
    await c.list(); expect(m.list).toHaveBeenLastCalledWith(100);
    await expect(c.list({ limit: 201 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await c.readiness()).toMatchObject({ recurringActivationSeparate: true, accountsCoverageConfirmationRequired: true }); noLookupOrApproval();
  });
  it("root mounts the standalone router and UI retains boolean coverage review, exact plan hash and future-only literal approval", () => {
    const root = readFileSync(new URL("./routers.ts", import.meta.url), "utf8");
    expect(root).toMatch(/manualForHireHandover:\s*manualForHireHandoverRouter/);
    const ui = readFileSync(new URL("../client/src/components/ManualForHireHandover.tsx", import.meta.url), "utf8");
    expect(ui).toMatch(/confirmedLatestCoverage:\s*boolean/); expect(ui).toMatch(/confirmedLatestCoverage:\s*false/);
    expect(ui).toMatch(/confirmedNoOtherFutureCoverage:\s*boolean/); expect(ui).toMatch(/confirmedNoOtherFutureCoverage:\s*false/);
    expect(ui).toMatch(/confirmedCoveredThrough:\s*boolean/); expect(ui).toMatch(/confirmedCoveredThrough:\s*false/);
    expect(ui).toMatch(/confirmedCoveredThrough:\s*true/);
    expect(ui).toMatch(/expectedPlanHash:\s*plan\.planHash/); expect(ui).toMatch(/manualCreationStopped:\s*true/);
    expect(ui).toMatch(/acknowledgement:\s*"FUTURE_ONLY_MANUAL_PO_HANDOVER"/);
    expect(ui).toMatch(/verified\.revision\s*!==\s*revision\.current/);
    expect(ui).toMatch(/verified\.key\s*!==\s*inputKey\(currentInput\.current\)/);
  });
});
