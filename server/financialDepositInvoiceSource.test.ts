import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  retrieve: vi.fn(),
  describe: vi.fn(),
  query: vi.fn(),
  v2: vi.fn(),
}));

vi.mock("./vtigerFinancialReadService", () => ({
  retrieveCurrentVtigerFinancialRecord: m.retrieve,
  describeVtigerFinancialModuleFields: m.describe,
  queryCurrentVtigerFinancialRecords: m.query,
}));
vi.mock("./financialCustomerContactSourceV2", () => ({
  readCurrentCustomerContactResolution: m.v2,
}));

import {
  DEPOSIT_V2_CUSTOMER_SNAPSHOT_MAPPING_KEY,
  readDepositInvoiceFacts,
} from "./financialDepositInvoiceSource";

const metadata = {
  name: "Potentials",
  fields: [
    { name: "potential_no", label: "Deal Number" },
    { name: "cf_real_status", label: "Deposit Status" },
    { name: "cf_potentials_extras", label: "Deposit Amount Required" },
    {
      name: "cf_potentials_emptycontainersupplydate",
      label: "Empty Container Supply Date",
    },
    {
      name: "cf_potentials_fullcontainercollectiondate",
      label: "Full Container Collection Date",
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  m.describe.mockResolvedValue(metadata);
  m.query.mockResolvedValue([]);
  m.retrieve.mockImplementation(async (id: string) => {
    if (id === "5x77") {
      return {
        id,
        potential_no: "D702941",
        potentialname: "Current Deal",
        related_to: "3x201",
        contact_id: "4x401",
        cf_potentials_quotereference: "6x1",
        cf_real_status: "PENDING",
        cf_potentials_extras: "110.00",
        cf_potentials_emptycontainersupplydate: "2026-10-12",
        cf_potentials_fullcontainercollectiondate: "",
        modifiedtime: "2026-10-11T01:00:00Z",
      };
    }
    if (id === "6x1") {
      return {
        id,
        quote_no: "Q-702941",
        account_id: "3x202",
        contact_id: "4x402",
      };
    }
    if (id === "3x202") {
      return {
        id,
        accountname: "Legacy Quote Organisation",
        modifiedtime: "2026-10-10T01:00:00Z",
      };
    }
    throw new Error(`unexpected record ${id}`);
  });
  m.v2.mockResolvedValue({
    dealId: "5x77",
    billingKind: "organisation",
    customerVtigerId: "3x201",
    organisationName: "Current Deal Organisation",
    contactName: "Ignored Current Contact",
    name: "Current Deal Organisation",
    email: "accounts@example.test",
    linkedAccountId: "3x201",
    linkedContactId: "4x401",
    sourceFieldsUsed: ["Deal.organizationname"],
    resolvedAt: "2026-10-11T01:00:00.000Z",
    sourceSnapshotHash: "v".repeat(64),
  });
  vi.stubEnv("FINANCIAL_CUSTOMER_CONTACT_V2_ENABLED", "false");
});
afterEach(() => vi.unstubAllEnvs());

describe("Deposit current customer source", () => {
  it("uses the shared v2 current Deal organisation identity, not the historical Quote party, when enabled", async () => {
    vi.stubEnv("FINANCIAL_CUSTOMER_CONTACT_V2_ENABLED", "true");

    const facts = await readDepositInvoiceFacts("5x77");

    expect(facts).toMatchObject({
      customerKind: "organisation",
      customerVtigerId: "3x201",
      customerName: "Current Deal Organisation",
      customerRefreshedAt: "2026-10-11T01:00:00.000Z",
      mappingEvidence: {
        [DEPOSIT_V2_CUSTOMER_SNAPSHOT_MAPPING_KEY]: "v".repeat(64),
      },
    });
    expect(m.v2).toHaveBeenCalledWith("5x77");
    expect(m.retrieve.mock.calls.map(([id]) => id)).toEqual(["5x77", "6x1"]);
  });

  it("preserves the legacy Quote-linked organisation source when the v2 gate is off", async () => {
    const facts = await readDepositInvoiceFacts("5x77");

    expect(facts).toMatchObject({
      customerKind: "organisation",
      customerVtigerId: "3x202",
      customerName: "Legacy Quote Organisation",
      customerRefreshedAt: "2026-10-10T01:00:00.000Z",
    });
    expect(facts.mappingEvidence).not.toHaveProperty(
      DEPOSIT_V2_CUSTOMER_SNAPSHOT_MAPPING_KEY
    );
    expect(m.v2).not.toHaveBeenCalled();
    expect(m.retrieve.mock.calls.map(([id]) => id)).toEqual([
      "5x77",
      "6x1",
      "3x202",
    ]);
  });
});
