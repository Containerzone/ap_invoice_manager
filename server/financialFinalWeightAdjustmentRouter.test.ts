import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ preview: vi.fn(), readiness: vi.fn(), events: vi.fn(), exact: vi.fn() }));
vi.mock("./financialFinalWeightAdjustmentService", () => ({ previewFinalWeightAdjustment: m.preview, getFinalWeightReadiness: m.readiness }));
vi.mock("./financialFinalWeightAdjustmentDb", () => ({ getFinalWeightEvents: m.events }));
vi.mock("./vtigerFinancialCandidateService", async original => ({ ...(await original<any>()), findExactFinancialCandidate: m.exact }));
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
const context = (role: "admin" | "user" | null): TrpcContext => ({ user: role ? { id: 7, openId: "synthetic", email: "test@example.invalid", name: "Test", loginMethod: "manus", role, createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() } : null, req: { headers: {}, protocol: "https" } as any, res: {} as any });
beforeEach(() => { vi.clearAllMocks(); m.preview.mockResolvedValue({ state: "held", noWrites: true }); m.readiness.mockResolvedValue({ noWrites: true }); m.events.mockResolvedValue([]); m.exact.mockResolvedValue({ outcome: "found", candidates: [{ recordId: "5x77" }] }); });
describe("Final weight administrator query-only workspace", () => {
  it.each([null, "user"] as const)("rejects %s before every source/readiness/ledger call", async role => {
    const caller = appRouter.createCaller(context(role)).financialOperations;
    await expect(caller.previewFinalWeightAdjustment({ exactDeal: "5x77", direction: "overweight" })).rejects.toMatchObject({ code: role ? "FORBIDDEN" : "UNAUTHORIZED" });
    await expect(caller.finalWeightReadiness()).rejects.toMatchObject({ code: role ? "FORBIDDEN" : "UNAUTHORIZED" });
    await expect(caller.finalWeightEvents()).rejects.toMatchObject({ code: role ? "FORBIDDEN" : "UNAUTHORIZED" });
    expect(m.preview).not.toHaveBeenCalled(); expect(m.events).not.toHaveBeenCalled(); expect(m.readiness).not.toHaveBeenCalled();
  });
  it("administrator preview exact webservice ID avoids discovery and passes only direction/id", async () => {
    const caller = appRouter.createCaller(context("admin")).financialOperations;
    await caller.previewFinalWeightAdjustment({ exactDeal: "5x77", direction: "underweight" });
    expect(m.preview).toHaveBeenCalledWith("5x77", "underweight", undefined); expect(m.exact).not.toHaveBeenCalled();
    await caller.finalWeightEvents({ limit: 25 }); await caller.finalWeightReadiness(); expect(m.events).toHaveBeenCalledWith(25);
  });
  it("D-number lookup is exact only and fails on ambiguity", async () => {
    const caller = appRouter.createCaller(context("admin")).financialOperations;
    await caller.previewFinalWeightAdjustment({ exactDeal: "D702877", direction: "overweight" });
    expect(m.exact).toHaveBeenCalledWith({ sourceCategory: "deal", businessNumber: "D702877" }); expect(m.preview).toHaveBeenCalledWith("5x77", "overweight", "D702877");
    m.exact.mockResolvedValue({ outcome: "ambiguous", candidates: [{}, {}], message: "Exact ambiguity" });
    await expect(caller.previewFinalWeightAdjustment({ exactDeal: "D702877", direction: "overweight" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });
  it("invalid record/direction is rejected before current source", async () => {
    const caller = appRouter.createCaller(context("admin")).financialOperations;
    await expect(caller.previewFinalWeightAdjustment({ exactDeal: "browse-all", direction: "overweight" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller.previewFinalWeightAdjustment({ exactDeal: "5x77", direction: "other" as any })).rejects.toMatchObject({ code: "BAD_REQUEST" }); expect(m.preview).not.toHaveBeenCalled();
  });
	 it("all three procedures are queries; parent workspace is admin-only and no browser writes/releases", () => {
    const procedures = appRouter._def.procedures;
    for (const key of ["finalWeightEvents", "finalWeightReadiness", "previewFinalWeightAdjustment"]) expect((procedures[`financialOperations.${key}`] as any)._def.type).toBe("query");
    const source = (path: string) => readFileSync(path, "utf8");
	   expect(source("client/src/App.tsx")).toMatch(/<Route path="\/financial-automation">\s*<AdminGuard><FinancialAutomation \/><\/AdminGuard>/);
	   expect(source("client/src/App.tsx")).toMatch(/<Route path="\/final-weight-adjustments">\s*<Redirect to="\/financial-automation\?tab=final-weight"/);
	   expect(source("client/src/components/DashboardLayout.tsx")).toMatch(/label: "Financial Automations"[^\n]+adminOnly: true/);
	   expect(source("client/src/pages/FinancialAutomation.tsx")).toContain('"final-weight": <FinalWeightAdjustments />');
    const page = source("client/src/pages/FinalWeightAdjustments.tsx"); expect(page).toContain("previewFinalWeightAdjustment.useQuery"); expect(page).not.toContain("useMutation");
  });
});
