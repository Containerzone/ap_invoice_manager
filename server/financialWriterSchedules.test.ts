import { describe, expect, it } from "vitest";
import {
  DISABLED_FINANCIAL_WRITER_SCHEDULES,
  getDisabledFinancialWriterSchedule,
} from "./financialWriterSchedules";

describe("disabled financial writer schedule definitions", () => {
  it("defines only the two approved recurring jobs without registering a runnable schedule", () => {
    expect(DISABLED_FINANCIAL_WRITER_SCHEDULES).toEqual([
      expect.objectContaining({
        workflowType: "recurring_for_hire",
        endpointPath: "/api/scheduled/financial-writer/recurring_for_hire",
        cadence: "0 0 0 1 * *",
        state: "disabled",
      }),
      expect.objectContaining({
        workflowType: "recurring_storage",
        endpointPath: "/api/scheduled/financial-writer/recurring_storage",
        cadence: "0 5 13 * * *",
        state: "disabled",
      }),
    ]);
  });

  it("does not expose event-driven families as schedules", () => {
    expect(getDisabledFinancialWriterSchedule("container_control_acquisition")).toBeUndefined();
    expect(getDisabledFinancialWriterSchedule("recurring_for_hire", "recurring_for_hire")).toMatchObject({
      workflowType: "recurring_for_hire",
    });
  });
});
