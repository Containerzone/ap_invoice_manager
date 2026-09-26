import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockGet } = vi.hoisted(() => ({ mockGet: vi.fn() }));
vi.mock("axios", () => ({ default: { get: mockGet } }));

import { findExactFinancialCandidate } from "./vtigerFinancialCandidateService";

function configuredEnvironment() {
  process.env.VTIGER_URL = "https://vtiger.example.test";
  process.env.VTIGER_USERNAME = "ap@example.test";
  process.env.VTIGER_ACCESS_KEY = "read-only-secret";
}

function successfulSession() {
  mockGet
    .mockResolvedValueOnce({ data: { success: true, result: { token: "challenge" } } })
    .mockResolvedValueOnce({ data: { success: true, result: { sessionName: "session" } } });
}

describe("exact VTiger financial candidate finder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configuredEnvironment();
  });

  afterEach(() => {
    delete process.env.VTIGER_URL;
    delete process.env.VTIGER_USERNAME;
    delete process.env.VTIGER_ACCESS_KEY;
  });

  it("uses only read-only GETs and finds one exact named deal", async () => {
    successfulSession();
    mockGet.mockResolvedValueOnce({ data: { success: true, result: [{ id: "4x702903", potentials_no: "D702903", accountname: "ContainerZone Customer", modifiedtime: "2026-09-26 09:00:00" }] } });
    const result = await findExactFinancialCandidate({
      sourceCategory: "deal",
      businessNumber: "D702903",
      configuration: { deal: [{ module: "Potentials", businessNumberFields: ["potentials_no"], selectFields: ["id", "potentials_no", "accountname", "modifiedtime"] }] },
    });
    expect(result).toMatchObject({ outcome: "found", businessNumber: "D702903" });
    expect(result.candidates[0]).toMatchObject({ recordId: "4x702903", matchedField: "potentials_no", sourceCategory: "deal" });
    expect(mockGet).toHaveBeenCalledTimes(3);
    const query = mockGet.mock.calls[2]?.[1]?.params?.query as string;
    expect(query).toContain("FROM Potentials WHERE potentials_no = 'D702903'");
    expect(query).not.toContain("LIMIT");
  });

  it("returns ambiguous instead of choosing one of multiple exact matches", async () => {
    successfulSession();
    mockGet.mockResolvedValueOnce({ data: { success: true, result: [{ id: "4x1" }, { id: "4x2" }] } });
    const result = await findExactFinancialCandidate({
      sourceCategory: "deal",
      businessNumber: "D702903",
      configuration: { deal: [{ module: "Potentials", businessNumberFields: ["potentials_no"], selectFields: ["id"] }] },
    });
    expect(result.outcome).toBe("ambiguous");
    expect(result.candidates.map((candidate) => candidate.recordId)).toEqual(["4x1", "4x2"]);
  });

  it("continues to the next configured exact alias when one VTiger field is unavailable", async () => {
    successfulSession();
    mockGet
      .mockResolvedValueOnce({ data: { success: false, error: { message: "Unknown field" } } })
      .mockResolvedValueOnce({ data: { success: true, result: [{ id: "4x702903", cf_deal_number: "D702903" }] } });
    const result = await findExactFinancialCandidate({
      sourceCategory: "deal",
      businessNumber: "D702903",
      configuration: { deal: [{ module: "Potentials", businessNumberFields: ["potentials_no", "cf_deal_number"], selectFields: ["id", "cf_deal_number"] }] },
    });
    expect(result).toMatchObject({ outcome: "found" });
    expect(result.candidates[0]?.matchedField).toBe("cf_deal_number");
  });

  it("escapes a business number as a single exact literal rather than expanding the query", async () => {
    successfulSession();
    mockGet.mockResolvedValueOnce({ data: { success: true, result: [] } });
    await findExactFinancialCandidate({
      sourceCategory: "deal",
      businessNumber: "D702903' OR id != ''",
      configuration: { deal: [{ module: "Potentials", businessNumberFields: ["potentials_no"], selectFields: ["id"] }] },
    });
    const query = mockGet.mock.calls[2]?.[1]?.params?.query as string;
    expect(query).toContain("potentials_no = 'D702903\\'");
    expect(query).not.toContain("WHERE potentials_no = 'D702903' OR");
    expect((query.match(/WHERE/g) ?? [])).toHaveLength(1);
  });

  it("records a blocked lookup result instead of throwing credential details", async () => {
    mockGet.mockRejectedValueOnce({ response: { status: 403 } });
    const result = await findExactFinancialCandidate({ sourceCategory: "deal", businessNumber: "D702903" });
    expect(result).toMatchObject({ outcome: "blocked", candidates: [], message: "VTiger rejected AP Management's read-only credentials." });
  });
});
