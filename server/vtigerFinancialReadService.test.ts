import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockGet, mockPost } = vi.hoisted(() => ({ mockGet: vi.fn(), mockPost: vi.fn() }));
vi.mock("axios", () => ({ default: { get: mockGet, post: mockPost } }));

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

  it("uses VTiger's documented GET challenge plus form-POST login before reporting a healthy credential", async () => {
    mockGet.mockResolvedValueOnce({ data: { success: true, result: { token: "challenge" } } });
    mockPost.mockResolvedValueOnce({ data: { success: true, result: { sessionName: "read-session" } } });

    const result = await testVtigerFinancialConnection();

    expect(result).toMatchObject({ configured: true, outcome: "passed" });
    expect(result.message).toContain("challenge and documented form-login passed");
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockGet.mock.calls[0]?.[1]?.params).toMatchObject({ operation: "getchallenge", username: "ap@example.test" });
    expect(mockPost.mock.calls[0]?.[1]).toContain("operation=login");
    expect(mockPost.mock.calls[0]?.[1]).toContain("username=ap%40example.test");
    expect(mockPost.mock.calls[0]?.[2]?.headers).toMatchObject({ "Content-Type": "application/x-www-form-urlencoded" });
  });

  it("does not report healthy access when the read-only login is rejected", async () => {
    mockGet.mockResolvedValueOnce({ data: { success: true, result: { token: "challenge" } } });
    mockPost.mockResolvedValueOnce({ data: { success: false, error: { message: "Specified token is invalid or expired" } } });

    const result = await testVtigerFinancialConnection();

    expect(result).toMatchObject({ configured: true, outcome: "failed" });
    expect(result.message).toContain("Specified token is invalid or expired");
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockPost).toHaveBeenCalledTimes(1);
  });
});
