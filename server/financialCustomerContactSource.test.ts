import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ retrieve: vi.fn(), describe: vi.fn() }));
vi.mock("./vtigerFinancialReadService", () => ({
  retrieveCurrentVtigerFinancialRecord: m.retrieve,
  describeVtigerFinancialModuleFields: m.describe,
}));
import { readCurrentCustomerContactSource } from "./financialCustomerContactSource";

beforeEach(() => {
  m.retrieve.mockReset();
  m.describe.mockReset();
  m.retrieve.mockResolvedValue({ id: "4x42", accountname: "Customer Pty Ltd", email1: "customer@example.test", mobile: "+61 400 000 001" });
  m.describe.mockResolvedValue({ name: "Accounts", fields: [
    { name: "accountname", label: "Organisation Name" },
    { name: "email1", label: "Email" },
    { name: "mobile", label: "Mobile" },
  ] });
});

describe("current customer contact source", () => {
  it("uses only current exact customer data and metadata-proven Email/Mobile fields", async () => {
    const result = await readCurrentCustomerContactSource({ customerVtigerId: "4x42", customerKind: "organisation", expectedCustomerName: "Customer Pty Ltd" });
    expect(result).toMatchObject({ name: "Customer Pty Ltd", email: "customer@example.test", phone: "+61 400 000 001" });
    expect(result.sourceSnapshotHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("does not guess an email alias where metadata is absent or ambiguous", async () => {
    m.describe.mockResolvedValue({ name: "Accounts", fields: [
      { name: "email1", label: "Email" }, { name: "email2", label: "Email" }, { name: "phone", label: "Phone" },
    ] });
    const result = await readCurrentCustomerContactSource({ customerVtigerId: "4x42", customerKind: "organisation", expectedCustomerName: "Customer Pty Ltd" });
    expect(result).toMatchObject({ email: null, phone: null });
  });

  it("holds if the current customer name no longer agrees with invoice evidence", async () => {
    m.retrieve.mockResolvedValue({ id: "4x42", accountname: "Changed Customer" });
    await expect(readCurrentCustomerContactSource({ customerVtigerId: "4x42", customerKind: "organisation", expectedCustomerName: "Customer Pty Ltd" }))
      .rejects.toThrow(/changed since invoice source evidence/);
  });
});
