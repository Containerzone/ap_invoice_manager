import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ describe: vi.fn(), retrieve: vi.fn() }));
vi.mock("./vtigerFinancialReadService", () => ({ describeVtigerFinancialModuleFields: m.describe, retrieveCurrentVtigerFinancialRecord: m.retrieve }));
import { readFinalWeightFacts, resolveFinalWeightSourceMappings } from "./financialFinalWeightAdjustmentSource";
import { deal, metadata } from "./_test/finalWeightFixtures";
beforeEach(() => { vi.clearAllMocks(); m.describe.mockResolvedValue(metadata()); m.retrieve.mockImplementation(async id => id === "5x77" ? deal() : { id, accountname: "Synthetic Customer", firstname: "Synthetic", lastname: "Contact", modifiedtime: "2026-10-10T00:00:00Z" }); });
describe("Final weight runtime metadata/source mapping", () => {
  it("resolves each verified exact label uniquely, including custom API names", () => {
    expect(resolveFinalWeightSourceMappings(metadata(), "underweight")).toMatchObject({ holdReason: null, mappingEvidence: { estimatedWeight: "mapped_estimatedWeight", actualWeight: "mapped_actualWeight", requiredDueDate: "mapped_requiredDueDate" } });
  });
  it.each(["missing", "duplicate-label", "duplicate-name", "wrong-case", "wrong-module", "wrong-type"])("holds %s metadata without guessing", mode => {
    const meta = metadata();
    if (mode === "missing") meta.fields = meta.fields.filter(f => f.name !== "mapped_actualWeight");
    if (mode === "duplicate-label") meta.fields.push({ ...meta.fields.find(f => f.name === "mapped_actualWeight")!, name: "another" });
    if (mode === "duplicate-name") meta.fields.push({ ...meta.fields[0]!, label: "Unrelated" });
    if (mode === "wrong-case") meta.fields[0]!.label = "deal id" as any;
    if (mode === "wrong-module") meta.name = "Quotes";
    if (mode === "wrong-type") meta.fields.find(f => f.name === "mapped_requiredDueDate")!.type = { name: "string" };
    expect(resolveFinalWeightSourceMappings(meta, "underweight").holdReason).toBeTruthy();
  });
  it("requires pickup-date mapping only for underweight", () => {
    const meta = metadata(); meta.fields = meta.fields.filter(f => f.name !== "mapped_requiredDueDate");
    expect(resolveFinalWeightSourceMappings(meta, "overweight").holdReason).toBeNull();
    expect(resolveFinalWeightSourceMappings(meta, "underweight").holdReason).toMatch(/Pickup/);
  });
  it.each(["missing", "ambiguous"])("holds overweight when Customer PO mapping is %s", async mode => {
    const meta = metadata();
    if (mode === "missing") meta.fields = meta.fields.filter(f => f.name !== "mapped_customerPO");
    if (mode === "ambiguous") meta.fields.push({ ...meta.fields.find(f => f.name === "mapped_customerPO")!, name: "another_customer_po" });
    m.describe.mockResolvedValue(meta);
    expect(resolveFinalWeightSourceMappings(meta, "overweight").holdReason).toMatch(/Customer PO.*missing or ambiguous/);
    const result = await readFinalWeightFacts("5x77", "overweight");
    expect(result.sourceHoldReason).toMatch(/Customer PO.*missing or ambiguous/);
    expect(m.retrieve.mock.calls).toEqual([["5x77"]]);
  });
  it("reads Customer PO from the current exact Deal for overweight", async () => {
    const result = await readFinalWeightFacts("5x77", "overweight");
    expect(result).toMatchObject({ customerPO: "Synthetic Customer PO", mappingEvidence: { customerPO: "mapped_customerPO" }, sourceHoldReason: null });
  });
  it("reads only exact Deal and linked organisation, validates mapping and date from current Deal", async () => {
    const result = await readFinalWeightFacts("5x77", "underweight");
    expect(result).toMatchObject({ dealId: "5x77", dealNumber: "D702877", customerPO: "", estimatedWeight: 10, actualWeight: 12.5, perExtraTonne: 100, requiredDueDate: "2026-10-20", customerVtigerId: "4x2", sourceHoldReason: null });
    expect(m.describe).toHaveBeenCalledWith("Potentials");
    expect(m.retrieve.mock.calls).toEqual([["5x77"], ["4x2"]]);
  });
  it("holds ambiguity before any customer retrieve", async () => {
    const meta = metadata(); meta.fields.push({ ...meta.fields[0]!, name: "duplicate" }); m.describe.mockResolvedValue(meta);
    expect((await readFinalWeightFacts("5x77", "overweight")).sourceHoldReason).toMatch(/ambiguous/);
    expect(m.retrieve.mock.calls).toEqual([["5x77"]]);
  });
  it("does not bypass malformed organisation through a contact", async () => {
    m.retrieve.mockResolvedValue(deal({ mapped_organisation: "bad-id" }));
    expect((await readFinalWeightFacts("5x77", "overweight")).sourceHoldReason).toMatch(/reference/);
    expect(m.retrieve).toHaveBeenCalledTimes(1);
  });
  it("uses contact only when organisation is genuinely blank", async () => {
    m.retrieve.mockImplementation(async id => id === "5x77" ? deal({ mapped_organisation: "" }) : { id, firstname: "Synthetic", lastname: "Contact" });
    expect((await readFinalWeightFacts("5x77", "overweight"))).toMatchObject({ customerKind: "contact", customerVtigerId: "12x3", customerName: "Synthetic Contact" });
  });
  it("holds absent/non-scalar fields, no currency parsing guesses and invalid locale date", async () => {
    m.retrieve.mockImplementation(async id => id === "5x77" ? deal({ mapped_actualWeight: undefined, mapped_perExtraTonne: "$100", mapped_requiredDueDate: "20-10-2026" }) : { id, accountname: "Synthetic Customer" });
    const result = await readFinalWeightFacts("5x77", "underweight");
    expect(result.sourceHoldReason).toMatch(/scalar/); expect(result.actualWeight).toBeNull(); expect(result.perExtraTonne).toBeNull(); expect(result.requiredDueDate).toBeNull();
  });
  it("rejects wrong exact record response and non-webservice IDs", async () => {
    m.retrieve.mockResolvedValue(deal({ id: "5x88" }));
    await expect(readFinalWeightFacts("5x77", "overweight")).rejects.toThrow(/different exact/);
    await expect(readFinalWeightFacts("D77", "overweight")).rejects.toThrow(/webservice ID/);
  });
});
