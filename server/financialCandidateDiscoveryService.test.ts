import { describe, expect, it } from "vitest";
import {
  discoverCurrentFamilyCandidates,
  FINANCIAL_FAMILY_CANDIDATE_PROFILES,
} from "./financialCandidateDiscoveryService";

describe("controlled all-family candidate discovery", () => {
  it("defines all fourteen scoped families exactly once", () => {
    expect(FINANCIAL_FAMILY_CANDIDATE_PROFILES).toHaveLength(14);
    expect(new Set(FINANCIAL_FAMILY_CANDIDATE_PROFILES.map((family) => family.familyKey)).size).toBe(14);
  });

  it("returns factual storage no-current-candidate without scanning VTiger history", async () => {
    for (const familyKey of ["recurring_storage", "storage_finalisation_recovery"] as const) {
      await expect(discoverCurrentFamilyCandidates({ familyKey })).resolves.toMatchObject({
        outcome: "no_current_candidate",
        candidates: [],
        message: expect.stringContaining("NO_CURRENT_CANDIDATE"),
      });
    }
  });

  it("blocks every non-storage family when no bounded current-state mapping exists rather than falling back to a broad lookup", async () => {
    const nonStorage = FINANCIAL_FAMILY_CANDIDATE_PROFILES.filter((family) => family.sourceCategory !== "storage_billing_event");
    const results = await Promise.all(nonStorage.map((family) => discoverCurrentFamilyCandidates({ familyKey: family.familyKey })));
    expect(results).toHaveLength(12);
    for (const result of results) {
      expect(result).toMatchObject({ outcome: "blocked", candidates: [] });
      expect(result.message).toContain("bounded AP-side current-candidate field mapping");
    }
  });
});
