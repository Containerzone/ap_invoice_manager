import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getRetryable: vi.fn(),
  getAction: vi.fn(),
  claim: vi.fn(),
  getConfig: vi.fn(),
  succeed: vi.fn(),
  fail: vi.fn(),
}));

vi.mock("./financialWorkflowDb", () => ({
  getRetryableFinancialPostSuccessActions: mocks.getRetryable,
  getFinancialPostSuccessActionById: mocks.getAction,
  claimFinancialPostSuccessAction: mocks.claim,
  getFinancialWorkflowConfig: mocks.getConfig,
  markFinancialPostSuccessActionSucceeded: mocks.succeed,
  markFinancialPostSuccessActionFailed: mocks.fail,
}));

import { retryFinancialPostSuccessActions } from "./vtigerFinancialWriteService";

describe("financial VTiger post-success retry worker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRetryable.mockResolvedValue([]);
  });

  it("does nothing when no independently retryable VTiger actions exist", async () => {
    await expect(retryFinancialPostSuccessActions()).resolves.toEqual({ considered: 0, succeeded: 0, failed: 0 });
    expect(mocks.getAction).not.toHaveBeenCalled();
  });

  it("claims at most the requested bounded set and never touches an Xero transport", async () => {
    mocks.getRetryable.mockResolvedValue([{ id: 10 }, { id: 11 }, { id: 12 }]);
    mocks.getAction.mockResolvedValue({ id: 10, status: "succeeded" });

    const result = await retryFinancialPostSuccessActions(2);

    expect(mocks.getRetryable).toHaveBeenCalledWith(2);
    expect(result).toEqual({ considered: 3, succeeded: 3, failed: 0 });
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.succeed).not.toHaveBeenCalled();
  });
});
