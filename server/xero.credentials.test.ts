import { describe, it, expect } from "vitest";

describe("Xero credentials", () => {
  it("XERO_CLIENT_ID is set and non-empty", () => {
    const id = process.env.XERO_CLIENT_ID;
    expect(id).toBeTruthy();
    expect(id!.length).toBeGreaterThan(5);
  });

  it("XERO_CLIENT_SECRET is set and non-empty", () => {
    const secret = process.env.XERO_CLIENT_SECRET;
    expect(secret).toBeTruthy();
    expect(secret!.length).toBeGreaterThan(5);
  });

  it("XERO_CLIENT_ID does not contain placeholder text", () => {
    const id = process.env.XERO_CLIENT_ID ?? "";
    expect(id.toLowerCase()).not.toContain("your_");
    expect(id.toLowerCase()).not.toContain("placeholder");
    expect(id.toLowerCase()).not.toContain("example");
  });
});
