import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ describe: vi.fn(), retrieve: vi.fn() }));
vi.mock("./vtigerFinancialReadService", () => ({ describeVtigerFinancialModuleFields: m.describe, retrieveCurrentVtigerFinancialRecord: m.retrieve }));
import { readWarrantyFacts, resolveWarrantySourceMappings } from "./financialWarrantyAvisoSource";
import { warrantyFixture } from "./financialWarrantyAvisoFixtures";
let f = warrantyFixture();
const metadata = () => ({ name: "Potentials", idPrefix: "5", fields: Object.values(f.config.fields).filter(Boolean) });
beforeEach(() => {
  vi.clearAllMocks(); f = warrantyFixture();
  m.describe.mockImplementation(async (name: string) => name === "Potentials" ? metadata() : { name, idPrefix: name === "Accounts" ? "4" : "3", fields: Object.values(f.config.customerFields[name === "Accounts" ? "organisation" : "contact"]) });
  m.retrieve.mockImplementation(async (id: string) => id === "5x77" ? { id, potential_no: "D77", cf_test_added: "Synthetic Warranty", related_to: "4x9", contact_id: "", modifiedtime: "2026-10-01T00:00:00Z", warranty_confirmed: "Yes" } : { id, accountname: "Synthetic Customer", firstname: "Synthetic", lastname: "Customer", modifiedtime: "2026-10-01T00:00:00Z" });
});
describe("Warranty authenticated metadata exact-source resolution", () => {
  it("reads one exact Deal and assigned customer only with fresh Potentials/customer metadata on every invocation", async () => {
    for (let i = 0; i < 2; i++) expect((await readWarrantyFacts("5x77", f.config)).holdReason).toBeNull();
    expect(m.describe.mock.calls).toEqual([["Potentials"], ["Accounts"], ["Potentials"], ["Accounts"]]);
    expect(m.retrieve.mock.calls).toEqual([["5x77"], ["4x9"], ["5x77"], ["4x9"]]);
  });
  it("missing actual field config produces factual hold with list, no record scans or guessed Added Services field", async () => {
    const result = await readWarrantyFacts("5x77", null); expect(result.holdReason).toMatch(/absent\/unproven/); expect(result.configurationRequired.length).toBeGreaterThan(0); expect(m.retrieve).not.toHaveBeenCalled();
  });
  it.each(["ambiguousLabel", "ambiguousApi", "typeDrift", "valueDrift", "prefix", "wrongModule", "confirmedInstead", "multipleMappings", "invalidPremium"])("holds on %s before record retrieve", async kind => {
    const meta: any = structuredClone(metadata());
    if (kind === "ambiguousLabel") meta.fields.push({ ...meta.fields[1], name: "another" });
    if (kind === "ambiguousApi") meta.fields.push({ ...meta.fields[1], label: "Another" });
    if (kind === "typeDrift") meta.fields[1].type.name = "string";
    if (kind === "valueDrift") meta.fields[1].type.picklistValues.push({ value: "Changed" });
    if (kind === "prefix") meta.idPrefix = "99";
    if (kind === "wrongModule") meta.name = "Quotes";
    if (kind === "confirmedInstead") { f.config.fields.addedServices.label = "Warranty Confirmed"; meta.fields[1].label = "Warranty Confirmed"; }
    if (kind === "multipleMappings") f.config.addedServicesMappings.push({ ...f.config.addedServicesMappings[0] });
    if (kind === "invalidPremium") f.config.addedServicesMappings[0].premiumExGst = 0;
    m.describe.mockResolvedValue(meta); const result = await readWarrantyFacts("5x77", f.config); expect(result.holdReason).not.toBeNull(); expect(m.retrieve).not.toHaveBeenCalled();
  });
  it.each(["No warranty", "Synthetic Warranty plus extras", "synthetic warranty", ""])("unsupported Added Services %s cannot use Warranty Confirmed", async value => {
    m.retrieve.mockResolvedValue({ id: "5x77", potential_no: "D77", cf_test_added: value, warranty_confirmed: "Yes", related_to: "4x9", contact_id: "", modifiedtime: "2026-10-01T00:00:00Z" });
    expect((await readWarrantyFacts("5x77", f.config)).holdReason).toMatch(/Added Services/);
  });
  it.each(["2026-10-01 12:00:00", "future", "", 17])("ambiguous timestamp %s holds without timezone inference", async stamp => {
    m.retrieve.mockResolvedValue({ id: "5x77", potential_no: "D77", cf_test_added: "Synthetic Warranty", related_to: "4x9", contact_id: "", modifiedtime: stamp });
    expect((await readWarrantyFacts("5x77", f.config)).holdReason).toMatch(/Modified Time|scalar/);
  });
  it("valid Contact only uses current Contacts name bindings", async () => {
    m.retrieve.mockImplementation(async (id: string) => id === "5x77" ? { id, potential_no: "D77", cf_test_added: "Synthetic Warranty", related_to: "", contact_id: "3x9", modifiedtime: "2026-10-01T00:00:00Z" } : { id, firstname: "Synthetic", lastname: "Customer", modifiedtime: "2026-10-01T00:00:00Z" });
    expect(await readWarrantyFacts("5x77", f.config)).toMatchObject({ customerKind: "contact", customerName: "Synthetic Customer", holdReason: null });
  });
  it("invalid organisation cannot fall back to contact, wrong source ID/module holds", async () => {
    m.retrieve.mockResolvedValue({ id: "5x77", potential_no: "D77", cf_test_added: "Synthetic Warranty", related_to: "wrong", contact_id: "3x9", modifiedtime: "2026-10-01T00:00:00Z" });
    expect((await readWarrantyFacts("5x77", f.config)).holdReason).toMatch(/fallback/);
    await expect(readWarrantyFacts("4x77", f.config)).rejects.toThrow(/module ID/);
  });
  it("mapped issue/due types must be date with explicit source semantics", () => {
    f.config.fields.issueDate = { name: "test_issue", label: "Synthetic issue", type: { name: "date" }, mandatory: false };
    expect(resolveWarrantySourceMappings(metadata() as any, f.config).holds.join(" ")).toMatch(/source_iso_date/);
  });
});
