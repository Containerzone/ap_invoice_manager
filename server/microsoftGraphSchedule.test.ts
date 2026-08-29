import { describe, expect, it } from "vitest";
import { selectMicrosoftRenewalTaskUid } from "./microsoftGraphSchedule";

describe("Microsoft Graph renewal schedule selection", () => {
  it("reuses the prior mailbox schedule when a dedicated mailbox has no schedule yet", () => {
    expect(selectMicrosoftRenewalTaskUid(undefined, "existing-task")).toBe("existing-task");
  });

  it("uses the dedicated mailbox schedule when it already exists", () => {
    expect(selectMicrosoftRenewalTaskUid("dedicated-task", "existing-task")).toBe("dedicated-task");
  });
});
