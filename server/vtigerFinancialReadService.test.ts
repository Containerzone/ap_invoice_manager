import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockGet, mockPost } = vi.hoisted(() => ({ mockGet: vi.fn(), mockPost: vi.fn() }));
vi.mock("axios", () => ({ default: { get: mockGet, post: mockPost } }));

import { describeVtigerFinancialModule, retrieveCurrentVtigerFinancialRecord, testVtigerFinancialConnection } from "./vtigerFinancialReadService";

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

  it("retries a transient GET challenge once without retrying the login POST", async () => {
    mockGet
      .mockRejectedValueOnce(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }))
      .mockResolvedValueOnce({ data: { success: true, result: { token: "challenge-one" } } })
    mockPost.mockResolvedValueOnce({ data: { success: true, result: { sessionName: "read-session" } } });

    await expect(testVtigerFinancialConnection()).resolves.toMatchObject({ outcome: "passed" });
    expect(mockGet).toHaveBeenCalledTimes(2);
    expect(mockGet.mock.calls.map(([, request]) => request?.params?.operation)).toEqual(["getchallenge", "getchallenge"]);
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it("reissues one fresh challenge/login cycle after VTiger's intermittent invalid-login response", async () => {
    mockGet
      .mockResolvedValueOnce({ data: { success: true, result: { token: "challenge-one" } } })
      .mockResolvedValueOnce({ data: { success: true, result: { token: "challenge-two" } } });
    mockPost
      .mockResolvedValueOnce({ data: { success: false, error: { message: "Invalid username or password" } } })
      .mockResolvedValueOnce({ data: { success: true, result: { sessionName: "read-session" } } });

    await expect(testVtigerFinancialConnection()).resolves.toMatchObject({ outcome: "passed" });
    expect(mockGet.mock.calls.map(([, request]) => request?.params?.operation)).toEqual(["getchallenge", "getchallenge"]);
    expect(mockPost).toHaveBeenCalledTimes(2);
  });

  it("retries a failed GET retrieve once but never retries the form-login POST", async () => {
    mockGet
      .mockResolvedValueOnce({ data: { success: true, result: { token: "challenge" } } })
      .mockRejectedValueOnce(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }))
      .mockResolvedValueOnce({ data: { success: true, result: { id: "5x77", potential_no: "D702946" } } });
    mockPost.mockResolvedValueOnce({ data: { success: true, result: { sessionName: "read-session" } } });

    await expect(retrieveCurrentVtigerFinancialRecord("5x77")).resolves.toMatchObject({ id: "5x77" });

    expect(mockGet.mock.calls.map(([, request]) => request?.params?.operation)).toEqual(["getchallenge", "retrieve", "retrieve"]);
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it("describes post-success mapping fields with GET-only metadata after session login", async () => {
    mockGet
      .mockResolvedValueOnce({ data: { success: true, result: { token: "challenge" } } })
      .mockResolvedValueOnce({ data: { success: true, result: { name: "Calendar", fields: [{ name: "parent_id" }, { name: "subject" }, { name: "due_date" }] } } });
    mockPost.mockResolvedValueOnce({ data: { success: true, result: { sessionName: "read-session" } } });
    await expect(describeVtigerFinancialModule("Calendar")).resolves.toEqual({ name: "Calendar", fields: ["parent_id", "subject", "due_date"] });
    expect(mockGet.mock.calls[1]?.[1]?.params).toMatchObject({ operation: "describe", elementType: "Calendar", sessionName: "read-session" });
    expect(mockPost).toHaveBeenCalledTimes(1);
  });
});
