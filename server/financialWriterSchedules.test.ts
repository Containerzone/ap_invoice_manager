import { describe, expect, it } from "vitest";
import {
  DISABLED_FINANCIAL_WRITER_SCHEDULES,
  getDisabledFinancialWriterSchedule,
} from "./financialWriterSchedules";
import { FINANCIAL_RELEASE_FAMILIES } from "./financialReleaseManifest";

describe("disabled financial writer schedule definitions", () => {
  it("covers every release family without registering a runnable schedule", () => {
    expect(DISABLED_FINANCIAL_WRITER_SCHEDULES).toHaveLength(FINANCIAL_RELEASE_FAMILIES.length);
    for (const family of FINANCIAL_RELEASE_FAMILIES) {
      const schedule = getDisabledFinancialWriterSchedule(family.workflowType, family.familyKey);
      expect(schedule).toMatchObject({
        workflowType: family.workflowType,
        familyKey: family.familyKey,
        endpointPath: `/api/scheduled/financial-writer/${family.familyKey}`,
      });
      expect(["details_required", "event_driven_only"]).toContain(schedule?.state);
    }
  });

  it("does not collapse different families that share a workflow evaluator", () => {
    const asset = getDisabledFinancialWriterSchedule("container_control_acquisition", "initial_container_control_asset");
    const sale = getDisabledFinancialWriterSchedule("container_control_acquisition", "initial_container_control_customer_sale");
    expect(asset?.familyKey).toBe("initial_container_control_asset");
    expect(sale?.familyKey).toBe("initial_container_control_customer_sale");
  });
});
