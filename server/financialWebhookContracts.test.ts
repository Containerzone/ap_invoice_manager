import { describe, expect, it } from "vitest";
import {
  FINANCIAL_AP_WEBHOOK_ROUTES,
  getFinancialWebhookRoute,
  isFinancialWebhookPaused,
  parseFinancialWebhookEnvelope,
  resolveFinancialWebhookControls,
} from "./financialWebhookContracts";

describe("AP financial webhook contracts", () => {
  it("defines fixed AP-owned proposal routes for all approved financial families", () => {
    expect(FINANCIAL_AP_WEBHOOK_ROUTES).toHaveLength(12);
    expect(FINANCIAL_AP_WEBHOOK_ROUTES.map((route) => route.key)).toContain("underweight-due-date");
    expect(FINANCIAL_AP_WEBHOOK_ROUTES.every((route) => route.path.startsWith("/api/financial-workflows/events/"))).toBe(true);
    expect(FINANCIAL_AP_WEBHOOK_ROUTES.every((route) => route.schedule === "event" || route.schedule === "future_schedule")).toBe(true);
  });

  it("accepts only the fixed versioned proposal envelope and never a live mode", () => {
    const accepted = parseFinancialWebhookEnvelope({
      apiVersion: "2026-09-29",
      mode: "proposal",
      eventId: "evt-100",
      eventType: "deal.updated",
      sourceSystem: "VTiger",
      sourceEntityType: "deal",
      sourceRecordId: "4x100",
      data: { customerOrganisationName: "Example Customer" },
    });
    expect(accepted).toMatchObject({ eventId: "evt-100", mode: "proposal" });
    expect(parseFinancialWebhookEnvelope({ ...accepted, mode: "live" })).toEqual(expect.objectContaining({ error: expect.stringContaining("proposal or dry_run") }));
  });

  it("resolves only recognised pause controls", () => {
    const route = getFinancialWebhookRoute("main-customer-invoice");
    expect(route).toBeDefined();
    const controls = resolveFinancialWebhookControls({ globalPaused: false, familyPaused: { "main-customer-invoice": true, unknown: true } });
    expect(isFinancialWebhookPaused(route!.key, controls)).toBe(true);
    expect(controls.familyPaused).not.toHaveProperty("unknown");
    expect(isFinancialWebhookPaused("deposit-invoice", controls)).toBe(false);
  });
});
