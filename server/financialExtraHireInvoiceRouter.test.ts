import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  preview: vi.fn(),
  readiness: vi.fn(),
  events: vi.fn(),
  exact: vi.fn(),
}));
vi.mock("./financialExtraHireInvoiceService", () => ({
  previewExtraHireInvoice: m.preview,
  getExtraHireReadiness: m.readiness,
}));
vi.mock("./financialExtraHireInvoiceDb", () => ({
  getExtraHireEvents: m.events,
}));
vi.mock("./vtigerFinancialCandidateService", async original => ({
  ...(await original<any>()),
  findExactFinancialCandidate: m.exact,
}));
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
const context = (role: "admin" | "user" | null): TrpcContext => ({
  user: role
    ? {
        id: 7,
        openId: "synthetic",
        email: "test@example.invalid",
        name: "Test",
        loginMethod: "manus",
        role,
        createdAt: new Date(),
        updatedAt: new Date(),
        lastSignedIn: new Date(),
      }
    : null,
  req: { headers: {}, protocol: "https" } as any,
  res: {} as any,
});
beforeEach(() => {
  vi.clearAllMocks();
  m.preview.mockResolvedValue({ state: "held", noWrites: true });
  m.readiness.mockResolvedValue({ noWrites: true });
  m.events.mockResolvedValue([]);
  m.exact.mockResolvedValue({
    outcome: "found",
    candidates: [{ recordId: "5x77" }],
  });
});
describe("Extra Hire administrator read-only workspace", () => {
  it.each([null, "user"] as const)(
    "rejects %s before source/readiness/ledger calls",
    async role => {
      const c = appRouter.createCaller(context(role)).financialOperations;
      for (const fn of [
        () => c.previewExtraHireInvoice({ exactDeal: "5x77" }),
        () => c.extraHireInvoiceEvents(),
        () => c.extraHireInvoiceReadiness(),
      ])
        await expect(fn()).rejects.toMatchObject({
          code: role ? "FORBIDDEN" : "UNAUTHORIZED",
        });
      expect(m.preview).not.toHaveBeenCalled();
      expect(m.events).not.toHaveBeenCalled();
      expect(m.readiness).not.toHaveBeenCalled();
    }
  );
  it("exact admin ID preview calls only that record, readiness and bounded local list", async () => {
    const c = appRouter.createCaller(context("admin")).financialOperations;
    await c.previewExtraHireInvoice({ exactDeal: "5x77" });
    expect(m.preview).toHaveBeenCalledWith("5x77", undefined);
    expect(m.exact).not.toHaveBeenCalled();
    await c.extraHireInvoiceEvents({ limit: 25 });
    await c.extraHireInvoiceReadiness();
    expect(m.events).toHaveBeenCalledWith(25);
  });
  it("D-number lookup passes exact expected number and holds ambiguous results", async () => {
    const c = appRouter.createCaller(context("admin")).financialOperations;
    await c.previewExtraHireInvoice({ exactDeal: "D77" });
    expect(m.exact).toHaveBeenCalledWith({
      sourceCategory: "deal",
      businessNumber: "D77",
    });
    expect(m.preview).toHaveBeenCalledWith("5x77", "D77");
    m.exact.mockResolvedValue({
      outcome: "ambiguous",
      candidates: [{}, {}],
      message: "Ambiguous",
    });
    await expect(
      c.previewExtraHireInvoice({ exactDeal: "D77" })
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });
  it("invalid ID is rejected before source", async () => {
    await expect(
      appRouter
        .createCaller(context("admin"))
        .financialOperations.previewExtraHireInvoice({
          exactDeal: "browse-all",
        })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(m.preview).not.toHaveBeenCalled();
  });
  it("all Extra Hire procedures are queries, admin-only parent workspace, no browser release/write control", () => {
    for (const key of [
      "extraHireInvoiceEvents",
      "extraHireInvoiceReadiness",
      "previewExtraHireInvoice",
    ])
      expect(
        (appRouter._def.procedures[`financialOperations.${key}`] as any)._def
          .type
      ).toBe("query");
    const source = (p: string) => readFileSync(p, "utf8");
    expect(source("client/src/App.tsx")).toMatch(
      /<Route path="\/financial-automation">\s*<AdminGuard><FinancialAutomation \/><\/AdminGuard>/
    );
    expect(source("client/src/App.tsx")).toMatch(
      /<Route path="\/extra-hire-invoices">\s*<Redirect to="\/financial-automation\?tab=extra-hire"/
    );
    expect(source("client/src/components/DashboardLayout.tsx")).toMatch(
      /label: "Financial Automations"[^\n]+adminOnly: true/
    );
    expect(source("client/src/pages/FinancialAutomation.tsx")).toContain('"extra-hire": <ExtraHireInvoices />');
    const page = source("client/src/pages/ExtraHireInvoices.tsx");
    expect(page).toContain("previewExtraHireInvoice.useQuery");
    expect(page).not.toContain("useMutation");
  });
});
