import { describe, expect, it, vi } from "vitest";

vi.mock("./vtigerFinancialReadService", () => ({
  describeVtigerFinancialModule: vi.fn(),
}));

import { describeVtigerFinancialModule } from "./vtigerFinancialReadService";
import { validateDisabledPostSuccessMapping } from "./financialPostSuccessReadiness";

describe("disabled VTiger post-success mapping readiness", () => {
  it("validates required module fields sequentially for a configured assignee", async () => {
    vi.mocked(describeVtigerFinancialModule)
      .mockResolvedValueOnce({ name: "ModComments", fields: ["related_to", "commentcontent"] })
      .mockResolvedValueOnce({ name: "Calendar", fields: ["parent_id", "subject", "due_date"] })
      .mockResolvedValueOnce({ name: "Potentials", fields: ["cf_potentials_hireenddate"] });

    const result = await validateDisabledPostSuccessMapping({ assignedUserId: "20x9" });

    expect(result.outcome).toBe("passed");
    expect(result.modules.map((module) => module.module)).toEqual(["ModComments", "Calendar", "Potentials"]);
    expect(vi.mocked(describeVtigerFinancialModule).mock.calls.map(([module]) => module))
      .toEqual(["ModComments", "Calendar", "Potentials"]);
  });
});
