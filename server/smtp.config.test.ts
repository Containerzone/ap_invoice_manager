import { describe, expect, it } from "vitest";

describe("SMTP configuration", () => {
  it("should have SMTP_HOST set to smtp.office365.com", () => {
    expect(process.env.SMTP_HOST).toBe("smtp.office365.com");
  });

  it("should have SMTP_PORT set to 587", () => {
    expect(process.env.SMTP_PORT).toBe("587");
  });

  it("should have SMTP_USER set to admin@containerzone.com.au", () => {
    expect(process.env.SMTP_USER).toBe("admin@containerzone.com.au");
  });

  it("should have SMTP_PASS configured", () => {
    expect(process.env.SMTP_PASS).toBeTruthy();
  });
});
