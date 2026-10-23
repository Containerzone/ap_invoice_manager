import { beforeEach, describe, expect, it, vi } from "vitest";

const { sharedSession } = vi.hoisted(() => ({ sharedSession: vi.fn() }));
vi.mock("./vtigerFinancialReadService", () => ({ withVtigerFinancialReadSession: sharedSession }));

import { findCurrentFinancialCandidates, findExactFinancialCandidate } from "./vtigerFinancialCandidateService";

function querySession(responses: Array<unknown>) {
  const query = vi.fn(async () => {
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return response;
  });
  sharedSession.mockImplementation(async (operation) => operation({ query }));
  return query;
}

describe("exact VTiger financial candidate finder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the shared financial read session for one bounded exact named-deal query", async () => {
    const query = querySession([[{ id: "4x702903", potentials_no: "D702903", accountname: "ContainerZone Customer", modifiedtime: "2026-09-26 09:00:00" }]]);

    const result = await findExactFinancialCandidate({
      sourceCategory: "deal",
      businessNumber: "D702903",
      configuration: { deal: [{ module: "Potentials", businessNumberFields: ["potentials_no"], selectFields: ["id", "potentials_no", "accountname", "modifiedtime"] }] },
    });

    expect(result).toMatchObject({ outcome: "found", businessNumber: "D702903" });
    expect(result.candidates[0]).toMatchObject({ recordId: "4x702903", matchedField: "potentials_no", sourceCategory: "deal" });
    expect(sharedSession).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(1);
    const sql = query.mock.calls[0]?.[0] as string;
    expect(sql).toContain("FROM Potentials WHERE potentials_no = 'D702903'");
    expect(sql).not.toContain("LIMIT");
  });

  it("returns ambiguous instead of choosing one of multiple exact matches", async () => {
    querySession([[{ id: "4x1" }, { id: "4x2" }]]);
    const result = await findExactFinancialCandidate({
      sourceCategory: "deal",
      businessNumber: "D702903",
      configuration: { deal: [{ module: "Potentials", businessNumberFields: ["potentials_no"], selectFields: ["id"] }] },
    });
    expect(result.outcome).toBe("ambiguous");
    expect(result.candidates.map((candidate) => candidate.recordId)).toEqual(["4x1", "4x2"]);
  });

  it("continues to the next configured exact alias when one VTiger field is unavailable", async () => {
    const query = querySession([new Error("Unknown field"), [{ id: "4x702903", cf_deal_number: "D702903" }]]);
    const result = await findExactFinancialCandidate({
      sourceCategory: "deal",
      businessNumber: "D702903",
      configuration: { deal: [{ module: "Potentials", businessNumberFields: ["potentials_no", "cf_deal_number"], selectFields: ["id", "cf_deal_number"] }] },
    });
    expect(result).toMatchObject({ outcome: "found" });
    expect(result.candidates[0]?.matchedField).toBe("cf_deal_number");
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("escapes a business number as a single exact literal rather than expanding the query", async () => {
    const query = querySession([[]]);
    await findExactFinancialCandidate({
      sourceCategory: "deal",
      businessNumber: "D702903' OR id != ''",
      configuration: { deal: [{ module: "Potentials", businessNumberFields: ["potentials_no"], selectFields: ["id"] }] },
    });
    const sql = query.mock.calls[0]?.[0] as string;
    expect(sql).toContain("potentials_no = 'D702903\\'");
    expect(sql).not.toContain("WHERE potentials_no = 'D702903' OR");
    expect((sql.match(/WHERE/g) ?? [])).toHaveLength(1);
  });

  it("records a blocked lookup result instead of throwing credential details", async () => {
    sharedSession.mockRejectedValueOnce(Object.assign(new Error("forbidden"), { response: { status: 403 } }));
    const result = await findExactFinancialCandidate({ sourceCategory: "deal", businessNumber: "D702903" });
    expect(result).toMatchObject({ outcome: "blocked", candidates: [], message: "VTiger rejected AP Management's read-only credentials." });
  });

  it("uses positive current predicates, recent sort and a hard ten-row cap for family discovery", async () => {
    const query = querySession([[{ id: "4x1", potentials_no: "D702903", sales_stage: "READY", modifiedtime: "2026-09-29 12:00:00" }]]);
    const result = await findCurrentFinancialCandidates({
      sourceCategory: "deal",
      queries: [{
        module: "Potentials", sourceCategory: "deal", selectFields: ["id", "potentials_no", "sales_stage", "modifiedtime"],
        predicates: [{ field: "sales_stage", operator: "equals", value: "READY" }], sortField: "modifiedtime", eligibilityReasons: ["Current READY stage"],
      }],
    });
    expect(result).toMatchObject({ outcome: "found", candidates: [expect.objectContaining({ recordId: "4x1", eligibilityReasons: ["Current READY stage"] })] });
    const sql = query.mock.calls[0]?.[0] as string;
    expect(sql).toContain("WHERE sales_stage = 'READY'");
    expect(sql).toContain("ORDER BY modifiedtime DESC LIMIT 10");
  });
});
