import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ describe: vi.fn(), retrieve: vi.fn() }));
vi.mock("./vtigerFinancialReadService", () => ({
  describeVtigerFinancialModuleFields: m.describe,
  retrieveCurrentVtigerFinancialRecord: m.retrieve,
}));
import {
  EXTRA_HIRE_FIELD_LABELS,
  readExtraHireFacts,
  resolveExtraHireSourceMappings,
} from "./financialExtraHireInvoiceSource";
const names = {
  dealNumber: "potential_no",
  containerNumber: "potentialname",
  containerType: "cf_potentials_containertype",
  hireDuration: "cf_potentials_howlongwouldyouliketohirefor",
  hireEndDate: "cf_potentials_hireenddate",
  organisation: "related_to",
  contact: "contact_id",
  modifiedTime: "modifiedtime",
};
function metadata() {
  return {
    name: "Potentials",
    fields: Object.entries(EXTRA_HIRE_FIELD_LABELS).map(([key, label]) => ({
      name: names[key as keyof typeof names],
      label: key === "hireDuration" ? `${label} ` : label,
      mandatory: false,
      type:
        key === "hireEndDate"
          ? { name: "date" }
          : key === "modifiedTime"
            ? { name: "datetime" }
            : key === "organisation"
              ? { name: "reference", refersTo: ["Accounts"] }
              : key === "contact"
                ? { name: "reference", refersTo: ["Contacts"] }
                : key === "hireDuration"
                  ? {
                      name: "picklist",
                      picklistValues: [
                        { value: "30 days" },
                        { value: "60 days" },
                      ],
                    }
                  : key === "containerType"
                    ? {
                        name: "picklist",
                        picklistValues: [
                          { value: "20 Foot Standard" },
                          { value: "40 Foot High Cube" },
                        ],
                      }
                    : { name: "string" },
    })),
  };
}
const deal = {
  id: "5x77",
  potential_no: "D77",
  potentialname: "ABCU1234567",
  cf_potentials_containertype: "20 Foot Standard",
  cf_potentials_howlongwouldyouliketohirefor: "30 days",
  cf_potentials_hireenddate: "2026-01-31",
  related_to: "3x88",
  contact_id: "",
  modifiedtime: "2026-01-01T00:00:00Z",
};
beforeEach(() => {
  vi.clearAllMocks();
  m.describe.mockResolvedValue(metadata());
  m.retrieve.mockImplementation(async id =>
    id === "5x77"
      ? deal
      : {
          id,
          accountname: "Synthetic Customer",
          modifiedtime: "2026-01-01T00:00:00Z",
        }
  );
});
describe("Extra Hire current metadata exact mappings", () => {
  it("detects current API names from labels, trims recorded duration label and proves field types", () =>
    expect(resolveExtraHireSourceMappings(metadata())).toEqual({
      mappingEvidence: names,
      holdReason: null,
    }));
  it.each([
    "dealNumber",
    "containerNumber",
    "containerType",
    "hireDuration",
    "hireEndDate",
    "organisation",
    "contact",
    "modifiedTime",
  ])("holds duplicate %s metadata", key => {
    const md = metadata();
    md.fields.push({
      ...md.fields.find(f => f.name === names[key as keyof typeof names])!,
      name: "duplicate",
    });
    expect(resolveExtraHireSourceMappings(md).holdReason).toMatch(/ambiguous/);
  });
  it("holds absent/date-type/reference-module/name ambiguity", () => {
    const absent = metadata();
    absent.fields = absent.fields.filter(
      f => f.label.trim() !== "Hire End Date"
    );
    expect(resolveExtraHireSourceMappings(absent).holdReason).toMatch(
      /missing/
    );
    const wrong = metadata();
    (wrong.fields.find(f => f.name === names.hireEndDate)!.type as any).name =
      "string";
    expect(resolveExtraHireSourceMappings(wrong).holdReason).toMatch(/type/);
    const ref = metadata();
    (
      ref.fields.find(f => f.name === names.organisation)!.type as any
    ).refersTo = ["Contacts"];
    expect(resolveExtraHireSourceMappings(ref).holdReason).toMatch(/reference/);
  });
  it("reads exact named Deal, organisation before contact, and current timestamp", async () => {
    const f = await readExtraHireFacts("5x77");
    expect(f).toMatchObject({
      dealNumber: "D77",
      hireDuration: 30,
      hireEndDate: "2026-01-31",
      containerFeet: 20,
      customerKind: "organisation",
      customerVtigerId: "3x88",
      mappingEvidence: names,
      sourceHoldReason: null,
    });
    expect(m.describe).toHaveBeenCalledWith("Potentials");
    expect(m.retrieve.mock.calls).toEqual([["5x77"], ["3x88"]]);
  });
  it("metadata ambiguity holds before customer read", async () => {
    const md = metadata();
    md.fields.push({ ...md.fields[0], name: "duplicate" });
    m.describe.mockResolvedValue(md);
    expect((await readExtraHireFacts("5x77")).sourceHoldReason).toMatch(
      /ambiguous/
    );
    expect(m.retrieve).toHaveBeenCalledTimes(1);
  });
  it("rejects invalid organisation without bypass fallback", async () => {
    m.retrieve.mockResolvedValue({
      ...deal,
      related_to: "Wrong",
      contact_id: "4x99",
    });
    expect((await readExtraHireFacts("5x77")).sourceHoldReason).toMatch(
      /Invalid exact/
    );
    expect(m.retrieve).toHaveBeenCalledTimes(1);
  });
  it("does not guess number 30 or locale dates from ambiguous source types", async () => {
    m.retrieve.mockResolvedValueOnce({
      ...deal,
      cf_potentials_howlongwouldyouliketohirefor: "30",
      cf_potentials_hireenddate: "31-01-2026",
    });
    const f = await readExtraHireFacts("5x77");
    expect(f.hireDuration).toBeNull();
    expect(f.hireEndDate).toBeNull();
    expect(f.sourceHoldReason).toMatch(/picklist|ISO/);
  });
  it("holds naive modified timestamps until source timezone semantics are proven", async () => {
    m.retrieve.mockResolvedValueOnce({
      ...deal,
      modifiedtime: "2026-01-01 00:00:00",
    });
    const f = await readExtraHireFacts("5x77");
    expect(f.sourceRefreshedAt).toBeNull();
    expect(f.sourceHoldReason).toMatch(/timezone is unconfirmed/);
  });
  it("rejects different retrieved record", async () => {
    m.retrieve.mockResolvedValue({ ...deal, id: "5x78" });
    await expect(readExtraHireFacts("5x77")).rejects.toThrow(/different exact/);
  });
});
