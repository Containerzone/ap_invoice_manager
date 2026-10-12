import { describe, expect, it } from "vitest";
import { testVtigerFinancialConnection } from "./vtigerFinancialReadService";

const liveIt = process.env.RUN_LIVE_VTIGER_READ_TEST === "true" ? it : it.skip;

describe("live VTiger financial read-only credential health", () => {
  liveIt("completes only a challenge and documented form-login", async () => {
    const result = await testVtigerFinancialConnection();
    expect(result).toMatchObject({ configured: true, missing: [], outcome: "passed" });
  }, 30_000);
});
