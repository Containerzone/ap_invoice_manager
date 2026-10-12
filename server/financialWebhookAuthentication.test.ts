import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FINANCIAL_AP_WEBHOOK_SECRET_ENV,
  FINANCIAL_VTIGER_WEBHOOK_SECRET_ENV,
  hasFinancialWebhookSecret,
} from "./financialWebhookAuthentication";

function request(input: { header?: string; bodySecret?: unknown }) {
  return {
    header: (name: string) =>
      name.toLowerCase() === "x-financial-webhook-secret"
        ? input.header
        : undefined,
    body:
      input.bodySecret === undefined ? {} : { secret: input.bodySecret },
  } as any;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("canonical AP financial webhook authentication", () => {
  it("accepts the canonical VTiger secret in the established JSON body", () => {
    vi.stubEnv(FINANCIAL_VTIGER_WEBHOOK_SECRET_ENV, "vtiger-canonical");
    vi.stubEnv(FINANCIAL_AP_WEBHOOK_SECRET_ENV, "previous-ap-secret");

    expect(hasFinancialWebhookSecret(request({ bodySecret: "vtiger-canonical" }))).toBe(true);
  });

  it("accepts the canonical secret in the HTTP header without reading the body", () => {
    vi.stubEnv(FINANCIAL_VTIGER_WEBHOOK_SECRET_ENV, "vtiger-canonical");
    const req = {
      header: () => "vtiger-canonical",
      get body() {
        throw new Error("header authentication must not parse the body");
      },
    } as any;

    expect(hasFinancialWebhookSecret(req)).toBe(true);
  });

  it("keeps the prior shared secret valid during the controlled rotation", () => {
    vi.stubEnv(FINANCIAL_VTIGER_WEBHOOK_SECRET_ENV, "vtiger-canonical");
    vi.stubEnv(FINANCIAL_AP_WEBHOOK_SECRET_ENV, "previous-ap-secret");

    expect(hasFinancialWebhookSecret(request({ bodySecret: "previous-ap-secret" }))).toBe(true);
  });

  it("accepts an isolated route-specific legacy secret without exposing it to other callers", () => {
    vi.stubEnv(FINANCIAL_VTIGER_WEBHOOK_SECRET_ENV, "vtiger-canonical");
    vi.stubEnv("FINANCIAL_MAIN_CUSTOMER_INVOICE_WEBHOOK_SECRET", "main-invoice-only");

    expect(
      hasFinancialWebhookSecret(request({ bodySecret: "main-invoice-only" }), [
        "FINANCIAL_MAIN_CUSTOMER_INVOICE_WEBHOOK_SECRET",
      ])
    ).toBe(true);
    expect(hasFinancialWebhookSecret(request({ bodySecret: "main-invoice-only" }))).toBe(false);
  });

  it("rejects a nonmatching secret", () => {
    vi.stubEnv(FINANCIAL_VTIGER_WEBHOOK_SECRET_ENV, "vtiger-canonical");
    expect(hasFinancialWebhookSecret(request({ bodySecret: "wrong" }))).toBe(false);
  });
});
