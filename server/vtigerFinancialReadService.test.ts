import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockGet } = vi.hoisted(() => ({ mockGet: vi.fn() }));
vi.mock("axios", () => ({ default: { get: mockGet } }));

import { testVtigerFinancialConnection } from "./vtigerFinancialReadService";

function configuredEnvironment() {
  process.env.VTIGER_URL = "https://vtiger.example.test";
  process.env.VTIGER_USERNAME = "ap@example.test";
  process.env.VTIGER_ACCESS_KEY = "read-only-secret";
}

describe("VTiger financial read-only connection health", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configuredEnvironment();
  });

  afterEach(() => {
    delete process.env.VTIGER_URL;
    delete process.env.VTIGER_USERNAME;
    delete process.env.VTIGER_ACCESS_KEY;
  });

  it("requires both GET-only challenge and login before reporting a healthy credential", async () => {
    mockGet
      .mockResolvedValueOnce({ data: { success: true, result: { token: "challenge" } } })
      .mockResolvedValueOnce({ data: { success: true, result: { sessionName: "read-session" } } });

    const result = await testVtigerFinancialConnection();

    expect(result).toMatchObject({ configured: true, outcome: "passed" });
    expect(result.message).toContain("challenge and login passed");
    expect(mockGet).toHaveBeenCalledTimes(2);
    expect(mockGet.mock.calls[0]?.[1]?.params).toMatchObject({ operation: "getchallenge", username: "ap@example.test" });
    expect(mockGet.mock.calls[1]?.[1]?.params).toMatchObject({ operation: "login", username: "ap@example.test" });
  });

  it("does not report healthy access when the read-only login is rejected", async () => {
    mockGet
      .mockResolvedValueOnce({ data: { success: true, result: { token: "challenge" } } })
      .mockResolvedValueOnce({ data: { success: false, error: { message: "Specified token is invalid or expired" } } });

    const result = await testVtigerFinancialConnection();

    expect(result).toMatchObject({ configured: true, outcome: "failed" });
    expect(result.message).toContain("Specified token is invalid or expired");
    expect(mockGet).toHaveBeenCalledTimes(2);
  });
});
