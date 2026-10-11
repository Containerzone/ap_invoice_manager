import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ preview: vi.fn(), readiness: vi.fn(), events: vi.fn() }));
vi.mock("./financialWarrantyAvisoService", () => ({ previewWarrantyAviso: m.preview, getWarrantyReadiness: m.readiness }));
vi.mock("./financialWarrantyAvisoDb", () => ({ getWarrantyEvents: m.events }));
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
const context = (role: "admin" | "user" | null): TrpcContext => ({
  user: role ? { id: 7, openId: "synthetic", email: "test@example.invalid", name: "Synthetic", loginMethod: "manus", role, createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() } : null,
  req: { headers: {}, protocol: "https" } as any, res: {} as any,
});
beforeEach(() => {
  vi.resetAllMocks();
  m.preview.mockResolvedValue({ state: "held", noWrites: true, holdReason: "Actual source mapping unproven" });
  m.readiness.mockResolvedValue({ writerEnabled: false, noWrites: true }); m.events.mockResolvedValue([]);
});

describe("Warranty administrator read-only workspace", () => {
  it.each([null, "user"] as const)("rejects %s before all preview/readiness/ledger calls", async role => {
    const c = appRouter.createCaller(context(role)).financialOperations;
    for (const fn of [() => c.previewWarrantyAviso({ exactDealId: "5x77" }), () => c.warrantyAvisoReadiness(), () => c.warrantyAvisoEvents()]) {
      await expect(fn()).rejects.toMatchObject({ code: role ? "FORBIDDEN" : "UNAUTHORIZED" });
    }
    expect(m.preview).not.toHaveBeenCalled(); expect(m.readiness).not.toHaveBeenCalled(); expect(m.events).not.toHaveBeenCalled();
  });
  it("admin receives only no-financial-write preview/readiness and bounded local event contracts", async () => {
    const c = appRouter.createCaller(context("admin")).financialOperations;
    expect(await c.previewWarrantyAviso({ exactDealId: "5x77" })).toMatchObject({ noWrites: true, state: "held" });
    expect(m.preview).toHaveBeenCalledWith("5x77");
    expect(await c.warrantyAvisoReadiness()).toMatchObject({ noWrites: true, writerEnabled: false });
    expect(await c.warrantyAvisoEvents({ limit: 25 })).toEqual([]);
    expect(m.events).toHaveBeenCalledWith(25);
  });
  it.each(["D77", "browse-all", "5x77,5x88", "5x1234567890123", ""])("rejects nonexact ID %s before source service", async exactDealId => {
    await expect(appRouter.createCaller(context("admin")).financialOperations.previewWarrantyAviso({ exactDealId })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(m.preview).not.toHaveBeenCalled();
  });
  it.each([0, 201, -1, 1.5])("rejects unbounded/invalid event limit %s", async limit => {
    await expect(appRouter.createCaller(context("admin")).financialOperations.warrantyAvisoEvents({ limit })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(m.events).not.toHaveBeenCalled();
  });
  it("only three Warranty procedures exist and each is a query with no release/write procedure", () => {
    const keys = Object.keys(appRouter._def.procedures).filter(key => /warrantyaviso/i.test(key));
    expect(keys.sort()).toEqual(["financialOperations.previewWarrantyAviso", "financialOperations.warrantyAvisoEvents", "financialOperations.warrantyAvisoReadiness"].sort());
    for (const key of keys) expect((appRouter._def.procedures[key] as any)._def.type).toBe("query");
    const source = (path: string) => readFileSync(path, "utf8");
    expect(source("client/src/App.tsx")).toMatch(/<Route path="\/warranty-aviso">\s*<AdminGuard><WarrantyAviso \/><\/AdminGuard>/);
    expect(source("client/src/components/DashboardLayout.tsx")).toMatch(/label: "Warranty & Aviso"[^\n]+adminOnly: true/);
    const page = source("client/src/pages/WarrantyAviso.tsx");
    expect(page).toContain("previewWarrantyAviso.useQuery"); expect(page).not.toContain("useMutation");
  });
});
