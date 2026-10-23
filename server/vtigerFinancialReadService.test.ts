import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockGet, mockPost } = vi.hoisted(() => ({ mockGet: vi.fn(), mockPost: vi.fn() }));
vi.mock("axios", () => ({ default: { get: mockGet, post: mockPost } }));

import { describeVtigerFinancialModule, retrieveCurrentVtigerFinancialRecord, testVtigerFinancialConnection } from "./vtigerFinancialReadService";
import { readDepositInvoiceFacts } from "./financialDepositInvoiceSource";
import { readMainCustomerInvoiceFacts } from "./financialMainCustomerInvoiceService";
import { readCurrentCustomerContactResolution } from "./financialCustomerContactSourceV2";

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
    delete process.env.FINANCIAL_CUSTOMER_CONTACT_V2_ENABLED;
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

  it("retries one GET read after a literal 429 with a short numeric Retry-After header", async () => {
    mockGet
      .mockResolvedValueOnce({ data: { success: true, result: { token: "challenge" } } })
      .mockRejectedValueOnce({ response: { status: 429, headers: { "retry-after": "0" } } })
      .mockResolvedValueOnce({ data: { success: true, result: { id: "5x77", potential_no: "D702946" } } });
    mockPost.mockResolvedValueOnce({ data: { success: true, result: { sessionName: "read-session" } } });

    await expect(retrieveCurrentVtigerFinancialRecord("5x77")).resolves.toMatchObject({ id: "5x77" });

    expect(mockGet.mock.calls.map(([, request]) => request?.params?.operation)).toEqual(["getchallenge", "retrieve", "retrieve"]);
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a long Retry-After header", { "retry-after": "6" }],
    ["a missing Retry-After header", {}],
  ])("does not retry a 429 GET read with %s", async (_description, headers) => {
    mockGet
      .mockResolvedValueOnce({ data: { success: true, result: { token: "challenge" } } })
      .mockRejectedValueOnce({ response: { status: 429, headers } });
    mockPost.mockResolvedValueOnce({ data: { success: true, result: { sessionName: "read-session" } } });

    await expect(retrieveCurrentVtigerFinancialRecord("5x77")).rejects.toMatchObject({ response: { status: 429 } });

    expect(mockGet.mock.calls.map(([, request]) => request?.params?.operation)).toEqual(["getchallenge", "retrieve"]);
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

  it("uses one challenge/login session for all sequential Deposit source reads", async () => {
    process.env.FINANCIAL_CUSTOMER_CONTACT_V2_ENABLED = "false";
    mockPost.mockResolvedValue({ data: { success: true, result: { sessionName: "deposit-read-session" } } });
    mockGet.mockImplementation(async (_url: string, request: { params: Record<string, string> }) => {
      const params = request.params;
      if (params.operation === "getchallenge") return { data: { success: true, result: { token: "deposit-challenge" } } };
      if (params.operation === "describe") return { data: { success: true, result: {
        name: "Potentials",
        fields: [
          { name: "potential_no", label: "Deal Number", type: {}, mandatory: false },
          { name: "cf_real_status", label: "Deposit Status", type: {}, mandatory: false },
          { name: "cf_potentials_extras", label: "Deposit Amount Required", type: {}, mandatory: false },
        ],
      } } };
      const records: Record<string, Record<string, unknown>> = {
        "5x77": {
          id: "5x77", potential_no: "D702941", potentialname: "Current Deal",
          related_to: "3x202", contact_id: "4x402", cf_potentials_quotereference: "6x1",
          cf_real_status: "PENDING", cf_potentials_extras: "110.00", modifiedtime: "2026-10-11T01:00:00Z",
        },
        "6x1": { id: "6x1", quote_no: "Q-702941", account_id: "3x202", contact_id: "4x402" },
        "3x202": { id: "3x202", accountname: "Current Organisation", modifiedtime: "2026-10-10T01:00:00Z" },
      };
      return { data: { success: true, result: records[params.id]! } };
    });

    await expect(readDepositInvoiceFacts("5x77")).resolves.toMatchObject({
      dealNumber: "D702941", quoteNumber: "Q-702941", customerName: "Current Organisation",
    });

    expect(mockGet.mock.calls.map(([, request]) => request?.params?.operation)).toEqual([
      "getchallenge", "retrieve", "describe", "retrieve", "retrieve",
    ]);
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockGet.mock.calls.slice(1).map(([, request]) => request?.params?.sessionName)).toEqual([
      "deposit-read-session", "deposit-read-session", "deposit-read-session", "deposit-read-session",
    ]);
  });

  it("uses one challenge/login session for all sequential Main Customer source reads", async () => {
    mockPost.mockResolvedValue({ data: { success: true, result: { sessionName: "main-read-session" } } });
    mockGet.mockImplementation(async (_url: string, request: { params: Record<string, string> }) => {
      const params = request.params;
      if (params.operation === "getchallenge") return { data: { success: true, result: { token: "main-challenge" } } };
      if (params.operation === "describe") return { data: { success: true, result: {
        name: "Potentials",
        fields: [
          { name: "cf_potentials_fullcontainercollectiondate", label: "Full Container Pickup DATE", type: { name: "date" }, mandatory: false },
          { name: "cf_potentials_depositstatus", label: "Deposit Status", type: { name: "picklist" }, mandatory: false },
        ],
      } } };
      const records: Record<string, Record<string, unknown>> = {
        "5x77": {
          id: "5x77", potential_no: "D702877", cf_potentials_quotereference: "20x9", related_to: "4x2",
          cf_potentials_fullcontainercollectiondate: "", cf_potentials_depositstatus: "PENDING",
          modifiedtime: "2026-10-11T01:00:00Z",
        },
        "20x9": { id: "20x9", quote_no: "Q-702877", LineItems: [{ productid: "14x1", quantity: "2", listprice: "250" }] },
        "4x2": { id: "4x2", accountname: "Main Customer" },
        "14x1": { id: "14x1", servicename: "Transport" },
      };
      return { data: { success: true, result: records[params.id]! } };
    });

    await expect(readMainCustomerInvoiceFacts("5x77")).resolves.toMatchObject({
      dealNumber: "D702877", quoteNumber: "Q-702877", customerName: "Main Customer",
      serviceLines: [{ serviceVtigerId: "14x1", description: "Transport", quantity: 2, unitAmount: 250 }],
    });

    expect(mockGet.mock.calls.map(([, request]) => request?.params?.operation)).toEqual([
      "getchallenge", "retrieve", "describe", "retrieve", "retrieve", "retrieve",
    ]);
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockGet.mock.calls.slice(1).map(([, request]) => request?.params?.sessionName)).toEqual([
      "main-read-session", "main-read-session", "main-read-session", "main-read-session", "main-read-session",
    ]);
  });

  it("groups v2 customer resolver reads into one session and releases it after the scope", async () => {
    mockPost.mockResolvedValue({ data: { success: true, result: { sessionName: "v2-read-session" } } });
    mockGet.mockImplementation(async (_url: string, request: { params: Record<string, string> }) => {
      const params = request.params;
      if (params.operation === "getchallenge") return { data: { success: true, result: { token: "v2-challenge" } } };
      const records: Record<string, Record<string, unknown>> = {
        "5x100": {
          id: "5x100", organizationname: "Customer Pty Ltd", contactname: "Jane Customer",
          related_to: "3x200", contact_id: "4x300", modifiedtime: "2026-10-13T00:00:00Z",
        },
        "3x200": { id: "3x200", accountname: "Customer Pty Ltd" },
        "4x300": { id: "4x300", firstname: "Jane", lastname: "Customer", email: "jane@example.test" },
      };
      return { data: { success: true, result: records[params.id]! } };
    });

    await expect(readCurrentCustomerContactResolution("5x100")).resolves.toMatchObject({
      billingKind: "organisation", customerVtigerId: "3x200", email: "jane@example.test",
    });

    expect(mockGet.mock.calls.map(([, request]) => request?.params?.operation)).toEqual([
      "getchallenge", "retrieve", "retrieve", "retrieve",
    ]);
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockGet.mock.calls.slice(1).map(([, request]) => request?.params?.sessionName)).toEqual([
      "v2-read-session", "v2-read-session", "v2-read-session",
    ]);

    mockGet.mockResolvedValueOnce({ data: { success: true, result: { token: "next-challenge" } } })
      .mockResolvedValueOnce({ data: { success: true, result: { id: "5x77" } } });
    mockPost.mockResolvedValueOnce({ data: { success: true, result: { sessionName: "next-read-session" } } });
    await retrieveCurrentVtigerFinancialRecord("5x77");
    expect(mockPost).toHaveBeenCalledTimes(2);
    expect(mockGet.mock.calls.slice(-1)[0]?.[1]?.params).toMatchObject({ sessionName: "next-read-session" });
  });
});
