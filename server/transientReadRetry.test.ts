import { describe, expect, it, vi } from "vitest";
import { retryReadOnce } from "./transientReadRetry";

describe("retryReadOnce", () => {
  it("retries one failed read and returns the recovered result", async () => {
    const read = vi.fn()
      .mockRejectedValueOnce(new Error("transient database query failure"))
      .mockResolvedValueOnce({ mailbox: "invoices@containerzone.com.au" });

    await expect(retryReadOnce(read, 0)).resolves.toEqual({ mailbox: "invoices@containerzone.com.au" });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("preserves the first error when the retry also fails", async () => {
    const firstError = new Error("initial database query failure");
    const read = vi.fn()
      .mockRejectedValueOnce(firstError)
      .mockRejectedValueOnce(new Error("retry database query failure"));

    await expect(retryReadOnce(read, 0)).rejects.toBe(firstError);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
