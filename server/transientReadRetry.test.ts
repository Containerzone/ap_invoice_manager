import { describe, expect, it, vi } from "vitest";
import { retryReadOnce, retryReadOnceWhen } from "./transientReadRetry";

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

  it("retries only the recognised transient read failure", async () => {
    const read = vi.fn()
      .mockRejectedValueOnce(new Error("Invalid username or password"))
      .mockResolvedValueOnce("read recovered");

    await expect(
      retryReadOnceWhen(
        read,
        error => error instanceof Error && /invalid username or password/i.test(error.message),
        0,
      ),
    ).resolves.toBe("read recovered");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("does not retry an unrecognised read failure", async () => {
    const error = new Error("invalid source schema");
    const read = vi.fn().mockRejectedValueOnce(error);

    await expect(retryReadOnceWhen(read, () => false, 0)).rejects.toBe(error);
    expect(read).toHaveBeenCalledTimes(1);
  });
});
