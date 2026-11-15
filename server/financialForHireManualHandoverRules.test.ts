import { describe, expect, it } from "vitest";
import { Temporal } from "@js-temporal/polyfill";
import type { ForHireContainerControlFacts } from "./financialForHireDrafts";
import { buildInitialForHirePo, buildRecurringForHirePo, formatForHireDate } from "./financialForHireDrafts";
import { financialSha256 } from "./financialProposalIntegrity";
import {
  MANUAL_FOR_HIRE_HANDOVER_RULES_HASH,
  buildManualForHireHandoverPlan,
  manualForHireEvidenceHash,
  manualForHireSourceIdentityHash,
  normalizeHandoverDate,
  type ManualForHireEvidence,
} from "./financialForHireManualHandoverRules";

type Input = Parameters<typeof buildManualForHireHandoverPlan>[0];

function fixture(size: 20 | 40 = 40, suffix = 1, start = "2026-11-13"): Input {
  const facts: ForHireContainerControlFacts = {
    recordId: "24x1929", controlNumber: "C1929", acquisition: "FOR HIRE", status: "ON HIRE",
    containerNumber: "TGHU1234567", containerType: `${size} Foot Standard`, collectionDate: start,
    supplierVtigerId: "18x44", supplierName: "Hire Supplier", monthlyCostInclusive: null,
    purchasePriceInclusive: null, liftAndBookingFeesInclusive: null, sourceRefreshedAt: "2026-11-13T00:00:00Z",
  };
  const end = Temporal.PlainDate.from(start).add({ days: suffix === 1 ? 30 : 29 }).toString();
  const preview = suffix === 1 ? buildInitialForHirePo(facts) : buildRecurringForHirePo({
    facts, priorPeriodEnd: Temporal.PlainDate.from(start).subtract({ days: 1 }).toString(),
    lastVerifiedExtensionSuffix: suffix === 2 ? null : suffix - 1, purchaseRate: 16.5, now: start,
  });
  const document = preview.document!;
  const manualPoNumber = document.proposedDocumentNumber!;
  const manualPo = {
    PurchaseOrderID: "manual-id", PurchaseOrderNumber: manualPoNumber, Status: "AUTHORISED", CurrencyCode: "AUD",
    Contact: { ContactID: "contact-44", Name: "Hire Supplier" }, HasErrors: false,
    Date: "2026-01-01", DueDate: "2026-01-02", Reference: facts.controlNumber, LineAmountTypes: "Exclusive",
    LineItems: document.lineItems.map((line) => ({ ItemCode: line.itemCode, Description: line.description,
      Quantity: line.quantity, AccountCode: line.accountCode, TaxType: "INPUT", UnitAmount: line.unitAmount })),
  };
  return { facts, evidence: { manualPo, relatedPurchaseOrders: [], supplierContactId: "contact-44", tenantId: "tenant-1", complete: true },
    manualPoNumber, coveredThrough: end, effectiveFrom: Temporal.PlainDate.from(end).add({ days: 1 }).toString(), now: start };
}

function otherPo(input: Input, options: { number?: string; id?: string; status?: string; start?: string; end?: string } = {}): Record<string, any> {
  return {
    PurchaseOrderID: options.id ?? "other-id", PurchaseOrderNumber: options.number ?? "EXTERNAL-HIRE", Status: options.status ?? "AUTHORISED",
    CurrencyCode: "AUD", Contact: { ContactID: input.evidence.supplierContactId }, HasErrors: false,
    LineItems: [{ ItemCode: "HC 40 E", Quantity: 30, AccountCode: "312", TaxType: "INPUT", UnitAmount: 9,
      Description: `${input.facts.containerNumber}, ${input.facts.containerType} Extended Hire from ${formatForHireDate(options.start ?? "2026-10-14")} to ${formatForHireDate(options.end ?? "2026-11-12")}` }],
  };
}

const hireLine = (input: Input): Record<string, any> => input.evidence.manualPo.LineItems[0];

function freezeDeep(value: any): void {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freezeDeep);
    Object.freeze(value);
  }
}

function reverseObjectKeys(value: any): any {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).reverse().map((key) => [key, reverseObjectKeys(value[key])]));
  return value;
}

describe("strict manual handover business dates", () => {
  it.each([
    ["2024-02-29", "2024-02-29"], ["29/02/24", "2024-02-29"], ["29/02/2024", "2024-02-29"],
    ["01/02/26", "2026-02-01"], ["02/01/2026", "2026-01-02"], ["31/12/99", "2099-12-31"],
    ["01/01/00", "2000-01-01"], ["2000-02-29", "2000-02-29"],
  ])("normalizes %s with explicit day-first slash semantics", (input, expected) => {
    expect(normalizeHandoverDate(input)).toBe(expected);
  });
  it.each([
    "2023-02-29", "29/02/23", "31/04/26", "2026-04-31", "2026-00-01", "00/12/26", "12/31/26",
    "13/13/26", "1/02/26", "01/2/26", "01-02-2026", "2026-2-01", " 2026-02-01", "2026-02-01 ",
    "2026-02-01T00:00:00Z", "", "0000-01-01", "29/02/1900", "2026-01-01[UTC]",
  ])("rejects invalid, non-native or US-only date %s", (input) => {
    expect(() => normalizeHandoverDate(input)).toThrow();
  });
  it("rejects non-string dates without coercion", () => {
    expect(() => normalizeHandoverDate(new Date() as unknown as string)).toThrow();
  });
});

describe("verified manual For Hire opening baseline", () => {
  it.each([20, 40] as const)("supports exact %i-foot initial and recurring native draft shapes", (size) => {
    for (const suffix of [1, 2, 7]) {
      const input = fixture(size, suffix);
      const plan = buildManualForHireHandoverPlan(input);
      expect(plan).toMatchObject({ containerControlId: "24x1929", containerControlNumber: "C1929", containerType: `${size} Foot Standard`,
        manualPoId: "manual-id", manualPoNumber: suffix === 1 ? "HC1929" : `HC1929-${suffix}`,
        manualSuffix: suffix, nextSuffix: suffix + 1, nextPoNumber: `HC1929-${suffix + 1}`, rulesHash: MANUAL_FOR_HIRE_HANDOVER_RULES_HASH,
        manualPeriodStart: "2026-11-13", coveredThrough: suffix === 1 ? "2026-12-13" : "2026-12-12",
        nextPeriodStart: suffix === 1 ? "2026-12-14" : "2026-12-13", nextPeriodEnd: suffix === 1 ? "2027-01-12" : "2027-01-11" });
    }
  });
  it.each(["DRAFT", "AUTHORISED", "BILLED"])("accepts manual status %s without creating a draft receipt", (status) => {
    const input = fixture(); input.evidence.manualPo.Status = status;
    const before = JSON.stringify(input); freezeDeep(input);
    const plan = buildManualForHireHandoverPlan(input);
    expect(plan.manualPoStatus).toBe(status);
    expect(JSON.stringify(input)).toBe(before);
    expect(Object.keys(plan).sort()).toEqual([
      "containerControlId", "containerControlNumber", "containerNumber", "containerType", "supplierVtigerId", "supplierName", "supplierContactId",
      "manualPoId", "manualPoNumber", "manualPoStatus", "manualPeriodStart", "coveredThrough", "nextPeriodStart", "nextPeriodEnd", "nextPoNumber",
      "manualSuffix", "nextSuffix", "effectiveFrom", "sourceIdentityHash", "xeroEvidenceHash", "planHash", "rulesHash",
    ].sort());
    expect(JSON.stringify(plan)).not.toMatch(/drafts_created|receipt|unitAmount|rate|payload/);
  });
  it("accepts IDLE and normalized source state while keeping exact business identifiers", () => {
    const input = fixture(); input.facts.status = " idle "; input.facts.acquisition = " for  hire ";
    expect(buildManualForHireHandoverPlan(input).containerControlNumber).toBe("C1929");
  });
  it("accepts HC1929 through 13 December as the baseline for HC1929-2 14 December–12 January", () => {
    const input = fixture(); input.coveredThrough = "13/12/26"; input.effectiveFrom = "14/12/2026"; input.now = "14/12/26";
    expect(buildManualForHireHandoverPlan(input)).toMatchObject({ coveredThrough: "2026-12-13", effectiveFrom: "2026-12-14",
      nextPeriodStart: "2026-12-14", nextPeriodEnd: "2027-01-12", nextPoNumber: "HC1929-2" });
  });
  it.each([1, 2])("uses strict leap-calendar arithmetic for suffix %i", (suffix) => {
    const input = fixture(20, suffix, "2024-01-30");
    const plan = buildManualForHireHandoverPlan(input);
    expect(plan.coveredThrough).toBe(suffix === 1 ? "2024-02-29" : "2024-02-28");
    expect(plan.nextPeriodStart).toBe(suffix === 1 ? "2024-03-01" : "2024-02-29");
    expect(plan.nextPeriodEnd).toBe(suffix === 1 ? "2024-03-30" : "2024-03-29");
  });
  it("never infers or corrects coverage from PO Date/DueDate or current collection date", () => {
    const input = fixture(); input.evidence.manualPo.Date = "2099-01-01"; input.evidence.manualPo.DueDate = "1900-01-01";
    input.facts.collectionDate = "2020-01-01";
    expect(buildManualForHireHandoverPlan(input).manualPeriodStart).toBe("2026-11-13");
    delete hireLine(input).Description;
    expect(() => buildManualForHireHandoverPlan(input)).toThrow(/native period/);
  });
  it("permits optional non-hire lift/booking fees without using their dates for coverage", () => {
    const input = fixture(); input.evidence.manualPo.LineItems.push({ ItemCode: "", Description: "Container Lift & Booking Fees from 01/01/26 to 31/12/26", Quantity: 1, AccountCode: "312", TaxType: "INPUT", UnitAmount: 50 });
    expect(buildManualForHireHandoverPlan(input).coveredThrough).toBe(input.coveredThrough);
  });
  it("allows initial native description without a container token but requires it on extensions", () => {
    const initial = fixture(20); expect(hireLine(initial).Description).not.toContain(initial.facts.containerNumber);
    expect(() => buildManualForHireHandoverPlan(initial)).not.toThrow();
    const recurring = fixture(20, 2); hireLine(recurring).Description = "20 Foot Standard Extended Hire from 13/11/26 to 12/12/26";
    expect(() => buildManualForHireHandoverPlan(recurring)).toThrow(/exact current container token/);
  });
  it("uses initial item size and canonical control binding without requiring the initial type text", () => {
    const input = fixture(); hireLine(input).Description = "Container Hire from 13/11/26 to 13/12/26";
    expect(buildManualForHireHandoverPlan(input).containerType).toBe("40 Foot Standard");
  });
  it("binds regex punctuation in a canonical control number literally", () => {
    const input = fixture(); input.facts.controlNumber = "C.19+29"; input.manualPoNumber = "HC.19+29";
    input.evidence.manualPo.PurchaseOrderNumber = input.manualPoNumber;
    expect(buildManualForHireHandoverPlan(input).nextPoNumber).toBe("HC.19+29-2");
  });
});

describe("fail-closed eligibility, exact manual evidence and no catch-up", () => {
  it.each([
    ["acquisition", "ASSET"], ["status", "REQUEST"], ["status", "DEHIRED"], ["status", "SOLD"],
    ["recordId", ""], ["controlNumber", ""], ["containerNumber", ""], ["containerType", ""],
    ["supplierVtigerId", ""], ["supplierName", ""], ["collectionDate", "2026-02-30"],
    ["containerType", "10 FOOT"], ["containerType", "20 / 40 FOOT"],
  ])("holds incomplete/ineligible source %s=%s", (field, value) => {
    const input = fixture(); (input.facts as any)[field] = value;
    expect(() => buildManualForHireHandoverPlan(input)).toThrow();
  });
  it("holds a changed Container Control instead of importing a different canonical PO", () => {
    const input = fixture(); input.facts.controlNumber = "C1930";
    expect(() => buildManualForHireHandoverPlan(input)).toThrow(/canonical/);
  });
  it.each(["HC1929-1", "HC1929-02", "HC1929-0", "HC1929--2", "HC1929-2x", "HC19290", "HC1929 ", "HC1929-9007199254740991"])("rejects non-canonical or unsafe series selection %s", (number) => {
    const input = fixture(); input.manualPoNumber = number; input.evidence.manualPo.PurchaseOrderNumber = number;
    expect(() => buildManualForHireHandoverPlan(input)).toThrow(/canonical/);
  });
  it.each([
    ["PurchaseOrderID", ""], ["PurchaseOrderNumber", "HC1929X"], ["Status", "DELETED"], ["Status", "VOIDED"],
    ["Status", "SUBMITTED"], ["Status", "AUTHORISED "], ["CurrencyCode", "USD"], ["CurrencyCode", "aud"],
    ["HasErrors", true], ["HasErrors", "false"], ["ValidationErrors", [{ Message: "bad" }]], ["LineItems", []],
    ["IsDeleted", true], ["IsVoided", true],
  ])("holds invalid manual PO %s", (field, value) => {
    const input = fixture(); input.evidence.manualPo[field] = value;
    expect(() => buildManualForHireHandoverPlan(input)).toThrow();
  });
  it.each(["complete", "supplierContactId", "tenantId"])("requires complete tenant-scoped evidence and expected contact: %s", (field) => {
    const input = fixture(); (input.evidence as any)[field] = field === "complete" ? false : "";
    expect(() => buildManualForHireHandoverPlan(input)).toThrow();
  });
  it("requires exact contact ID, not a supplier name match", () => {
    const input = fixture(); input.evidence.manualPo.Contact.ContactID = "contact-other";
    expect(() => buildManualForHireHandoverPlan(input)).toThrow(/ContactID/);
  });
  it("rejects a changed expected vendor mapping", () => {
    const input = fixture(); input.facts.supplierVtigerId = "18x45"; input.evidence.supplierContactId = "contact-45";
    expect(() => buildManualForHireHandoverPlan(input)).toThrow(/ContactID/);
  });
  it.each([
    ["ItemCode", "HC 20"], ["ItemCode", "HC 40 E"], ["ItemCode", "JD 40"], ["Quantity", 30],
    ["Quantity", 0], ["AccountCode", "313"], ["TaxType", "OUTPUT"], ["TaxType", "NONE"],
  ])("holds mismatched initial hire line %s=%s", (field, value) => {
    const input = fixture(); hireLine(input)[field] = value;
    expect(() => buildManualForHireHandoverPlan(input)).toThrow();
  });
  it.each([["ItemCode", "HC 20 E"], ["ItemCode", "HC 40"], ["Quantity", 1]])("holds mismatched recurring hire line %s=%s", (field, value) => {
    const input = fixture(40, 2); hireLine(input)[field] = value;
    expect(() => buildManualForHireHandoverPlan(input)).toThrow();
  });
  it("accepts compact HC40/HC40E codes and native numeric-string quantities", () => {
    for (const suffix of [1, 2]) {
      const input = fixture(40, suffix); hireLine(input).ItemCode = suffix === 1 ? "HC40" : "HC40E";
      hireLine(input).Quantity = suffix === 1 ? "1" : "30";
      expect(() => buildManualForHireHandoverPlan(input)).not.toThrow();
    }
  });
  it.each([
    "OTHER1234567, 40 Foot Standard Extended Hire @ $16.50 per day from 13/11/26 to 12/12/26",
    "XTGHU1234567, 40 Foot Standard Extended Hire from 13/11/26 to 12/12/26",
    "TGHU12345670, 40 Foot Standard Extended Hire from 13/11/26 to 12/12/26",
    "TGHU1234567, 20 Foot Standard Extended Hire from 13/11/26 to 12/12/26",
    "TGHU1234567, 40 Foot High Cube Extended Hire from 13/11/26 to 12/12/26",
    "TGHU1234567, X40 Foot StandardX Extended Hire from 13/11/26 to 12/12/26",
    "TGHU1234567 and ABCD9876543, 40 Foot Standard Extended Hire from 13/11/26 to 12/12/26",
  ])("holds incorrect or partial recurring container/type tokens: %s", (description) => {
    const input = fixture(40, 2); hireLine(input).Description = description;
    expect(() => buildManualForHireHandoverPlan(input)).toThrow();
  });
  it("rejects an initial description with the wrong size or an explicit different container", () => {
    for (const description of ["20' Container Hire from 13/11/26 to 13/12/26", "ABCD9876543, 40' Container Hire from 13/11/26 to 13/12/26"]) {
      const input = fixture(); hireLine(input).Description = description;
      expect(() => buildManualForHireHandoverPlan(input)).toThrow();
    }
  });
  it.each([
    "40' Container Hire from 13/11/26 to 13/12/26 and from 14/12/26 to 12/01/27",
    "40' Container Hire from 13/11/2026 to 13/12/2026",
    "40' Container Hire from 2026-11-13 to 2026-12-13",
    "40' Container Hire from 31/11/26 to 13/12/26",
    "40' Container Hire from 13/11/26 to 12/11/26",
    "40' Container Hire from 13/11/26 to 12/12/26",
    "40' Container Hire from 13/11/26 to 14/12/26",
    "40' Container Hire from 13/11/26 to 13/12/26 adjusted 01/11/26",
    "40' Container Hire Date 13/11/26 DueDate 13/12/26",
    "40' Container Hire from 13/11/26 to 13/12/26 and from 14 Dec to 12 Jan",
  ])("rejects multi-period, invalid, non-native or incorrect-duration coverage: %s", (description) => {
    const input = fixture(); hireLine(input).Description = description;
    expect(() => buildManualForHireHandoverPlan(input)).toThrow();
  });
  it("rejects recurring +30-day coverage even if the owner enters the same end", () => {
    const input = fixture(40, 2); hireLine(input).Description = hireLine(input).Description.replace("12/12/26", "13/12/26");
    input.coveredThrough = "2026-12-13";
    expect(() => buildManualForHireHandoverPlan(input)).toThrow(/\+29/);
  });
  it("rejects an owner-entered end different from the native coverage", () => {
    const input = fixture(); input.coveredThrough = "2026-12-12";
    expect(() => buildManualForHireHandoverPlan(input)).toThrow(/coveredThrough/);
  });
  it.each([
    { ItemCode: "HC 40", Description: "another hire period" },
    { ItemCode: "HC 20 E", Description: "another container" },
    { ItemCode: "JD 40", Description: "container storage" },
    { ItemCode: "A 40", Description: "purchase" },
    { ItemCode: "", Description: "Other container rental from 01/12/26 to 30/12/26" },
    { ItemCode: "", Description: "ABCD9876543, 40 Foot Standard" },
  ])("rejects another hire/container line $ItemCode $Description", (extra) => {
    const input = fixture(); input.evidence.manualPo.LineItems.push({ ...extra, Quantity: 1 });
    expect(() => buildManualForHireHandoverPlan(input)).toThrow(/Exactly one hire/);
  });
  it.each([
    { now: "2026-12-15", effectiveFrom: "2026-12-15" },
    { now: "2026-11-13", effectiveFrom: "2026-11-12" },
    { now: "2026-11-13", effectiveFrom: "2026-12-15" },
  ])("never catches up, skips or rolls the next consecutive period: $now / $effectiveFrom", (dates) => {
    const input = { ...fixture(), ...dates };
    expect(() => buildManualForHireHandoverPlan(input)).toThrow(/no catch-up/);
  });
  it.each(["now", "effectiveFrom", "coveredThrough"])("rejects an invalid owner/business date %s", (field) => {
    const input = fixture(); (input as any)[field] = "2026-02-30";
    expect(() => buildManualForHireHandoverPlan(input)).toThrow();
  });
});

describe("complete scoped series and overlap verification", () => {
  it("accepts explicit Accounts attestation without fabricating complete scoped history", () => {
    const input = fixture(); input.evidence.complete = false;
    input.evidence.coverageAttestation = { confirmedLatestCoverage: true, confirmedNoOtherFutureCoverage: true, reviewedBy: 44 };
    const before = JSON.stringify(input); freezeDeep(input);
    expect(buildManualForHireHandoverPlan(input).nextPoNumber).toBe("HC1929-2");
    expect(input.evidence.complete).toBe(false);
    expect(JSON.stringify(input)).toBe(before);
  });
  it.each([
    undefined, {}, { confirmedLatestCoverage: true, reviewedBy: 44 },
    { confirmedLatestCoverage: false, confirmedNoOtherFutureCoverage: true, reviewedBy: 44 },
    { confirmedLatestCoverage: true, confirmedNoOtherFutureCoverage: false, reviewedBy: 44 },
    { confirmedLatestCoverage: true, confirmedNoOtherFutureCoverage: true },
    { confirmedLatestCoverage: true, confirmedNoOtherFutureCoverage: true, reviewedBy: 0 },
    { confirmedLatestCoverage: true, confirmedNoOtherFutureCoverage: true, reviewedBy: -1 },
    { confirmedLatestCoverage: true, confirmedNoOtherFutureCoverage: true, reviewedBy: 1.5 },
    { confirmedLatestCoverage: true, confirmedNoOtherFutureCoverage: true, reviewedBy: "44" },
  ])("holds incomplete history without both true attestations and a positive admin reviewer: %j", (attestation) => {
    const input = fixture(); input.evidence.complete = false; input.evidence.coverageAttestation = attestation as any;
    expect(() => buildManualForHireHandoverPlan(input)).toThrow(/Accounts/);
  });
  it("never lets attestation override known higher suffix or overlap evidence", () => {
    for (const kind of ["higher", "overlap"]) {
      const input = fixture(); input.evidence.complete = false;
      input.evidence.coverageAttestation = { confirmedLatestCoverage: true, confirmedNoOtherFutureCoverage: true, reviewedBy: 44 };
      input.evidence.relatedPurchaseOrders = [kind === "higher" ? otherPo(input, { number: "HC1929-2", status: "DELETED" })
        : otherPo(input, { start: "2026-12-14", end: "2027-01-12" })];
      expect(() => buildManualForHireHandoverPlan(input)).toThrow(kind === "higher" ? /higher canonical/ : /overlaps/);
    }
  });
  it.each(["DRAFT", "AUTHORISED", "BILLED", "VOIDED", "DELETED", "UNKNOWN"])("holds a higher canonical suffix in ANY status %s", (status) => {
    const input = fixture(); input.evidence.relatedPurchaseOrders = [otherPo(input, { number: "HC1929-2", status })];
    expect(() => buildManualForHireHandoverPlan(input)).toThrow(/higher canonical/);
  });
  it("holds a higher suffix even when next itself is absent; never jumps to an unused number", () => {
    const input = fixture(40, 2); input.evidence.relatedPurchaseOrders = [otherPo(input, { number: "HC1929-9", status: "DELETED" })];
    expect(() => buildManualForHireHandoverPlan(input)).toThrow(/higher canonical/);
  });
  it.each([
    ["2026-12-14", "2027-01-12"], ["2026-12-01", "2026-12-20"], ["2027-01-12", "2027-02-10"],
    ["2026-11-01", "2026-11-13"], ["2026-11-13", "2026-12-13"], ["2026-12-13", "2027-01-11"],
    ["2026-10-01", "2027-02-01"],
  ])("holds inclusive overlapping manual/next coverage %s to %s", (start, end) => {
    const input = fixture(); input.evidence.relatedPurchaseOrders = [otherPo(input, { start, end })];
    expect(() => buildManualForHireHandoverPlan(input)).toThrow(/overlaps/);
  });
  it.each(["VOIDED", "DELETED"])("ignores inactive non-reserved overlap in %s without changing that PO", (status) => {
    const input = fixture(); input.evidence.relatedPurchaseOrders = [otherPo(input, { status, start: "2026-12-14", end: "2027-01-12" })];
    const before = JSON.stringify(input); freezeDeep(input);
    expect(() => buildManualForHireHandoverPlan(input)).not.toThrow();
    expect(JSON.stringify(input)).toBe(before);
  });
  it("permits a verified lower suffix ending the day before the manual recurring period", () => {
    const input = fixture(40, 3); input.evidence.relatedPurchaseOrders = [otherPo(input, { number: "HC1929-2" })];
    expect(buildManualForHireHandoverPlan(input).nextPoNumber).toBe("HC1929-4");
  });
  it("permits an exact duplicate view of the selected manual ID, but not conflicting business evidence", () => {
    const input = fixture(); input.evidence.relatedPurchaseOrders = [structuredClone(input.evidence.manualPo)];
    expect(() => buildManualForHireHandoverPlan(input)).not.toThrow();
    input.evidence.relatedPurchaseOrders[0].Status = "BILLED";
    expect(() => buildManualForHireHandoverPlan(input)).toThrow(/conflicting/);
  });
  it("holds a different ID occupying the exact selected manual number, including deleted", () => {
    const input = fixture(); input.evidence.relatedPurchaseOrders = [otherPo(input, { number: input.manualPoNumber, status: "DELETED" })];
    expect(() => buildManualForHireHandoverPlan(input)).toThrow(/different PO ID/);
  });
  it.each(["HC1929-01", "HC1929-02", "HC1929-X", "HC1929-90071992547409999"])("holds unsafe scoped canonical-series variants %s", (number) => {
    const input = fixture(); input.evidence.relatedPurchaseOrders = [otherPo(input, { number })];
    expect(() => buildManualForHireHandoverPlan(input)).toThrow(/non-canonical/);
  });
  it("holds incomplete related active hire descriptions instead of inferring PO Date/DueDate", () => {
    const input = fixture(); const related = otherPo(input); related.LineItems[0].Description = "Container Hire";
    related.Date = "2026-10-14"; related.DueDate = "2026-11-12"; input.evidence.relatedPurchaseOrders = [related];
    expect(() => buildManualForHireHandoverPlan(input)).toThrow(/native/);
  });
  it("holds an extra period on a related line even when its first range is historical", () => {
    const input = fixture(); const related = otherPo(input);
    related.LineItems[0].Description += " and from 14/12/26 to 12/01/27"; input.evidence.relatedPurchaseOrders = [related];
    expect(() => buildManualForHireHandoverPlan(input)).toThrow(/Exactly one native/);
  });
  it("holds missing related line evidence, errors and duplicate IDs", () => {
    for (const mutate of [
      (po: Record<string, any>) => { delete po.LineItems; },
      (po: Record<string, any>) => { po.HasErrors = true; },
      (po: Record<string, any>) => { po.PurchaseOrderID = ""; },
      (po: Record<string, any>) => { delete po.Status; },
      (po: Record<string, any>) => { po.IsDeleted = true; },
    ]) {
      const input = fixture(); const related = otherPo(input); mutate(related); input.evidence.relatedPurchaseOrders = [related];
      expect(() => buildManualForHireHandoverPlan(input)).toThrow();
    }
    const input = fixture(); const related = otherPo(input); input.evidence.relatedPurchaseOrders = [related, structuredClone(related)];
    expect(() => buildManualForHireHandoverPlan(input)).toThrow(/Duplicate scoped/);
  });
});

describe("canonical handover source, Xero evidence and plan hashes", () => {
  it("binds explicit Accounts attestation, reviewer, confirmations and truthful completeness", () => {
    const input = fixture(); input.evidence.complete = false;
    const absent = manualForHireEvidenceHash(input.evidence);
    input.evidence.coverageAttestation = { confirmedLatestCoverage: true, confirmedNoOtherFutureCoverage: true, reviewedBy: 44 };
    const attested = manualForHireEvidenceHash(input.evidence);
    expect(attested).not.toBe(absent);
    for (const mutate of [
      (e: ManualForHireEvidence) => { e.coverageAttestation!.reviewedBy = 45; },
      (e: ManualForHireEvidence) => { (e.coverageAttestation as any).confirmedLatestCoverage = false; },
      (e: ManualForHireEvidence) => { (e.coverageAttestation as any).confirmedNoOtherFutureCoverage = false; },
      (e: ManualForHireEvidence) => { e.complete = true; },
    ]) {
      const changed = structuredClone(input.evidence); mutate(changed);
      expect(manualForHireEvidenceHash(changed)).not.toBe(attested);
    }
    expect(manualForHireEvidenceHash(reverseObjectKeys(input.evidence))).toBe(attested);
  });
  it("exports a deterministic SHA256 version and hashes all plan fields except planHash", () => {
    expect(MANUAL_FOR_HIRE_HANDOVER_RULES_HASH).toBe(financialSha256("manual-for-hire-handover/2026-11-15/v1"));
    const input = fixture(); const { planHash, ...fields } = buildManualForHireHandoverPlan(input);
    expect(planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(planHash).toBe(financialSha256(fields));
    expect(fields.sourceIdentityHash).toBe(manualForHireSourceIdentityHash(input.facts));
    expect(fields.xeroEvidenceHash).toBe(manualForHireEvidenceHash(input.evidence));
  });
  it.each(["recordId", "controlNumber", "acquisition", "containerNumber", "containerType", "supplierVtigerId", "supplierName"])("binds persistent source identity %s", (field) => {
    const input = fixture(); const hash = manualForHireSourceIdentityHash(input.facts);
    (input.facts as any)[field] += "-changed";
    expect(manualForHireSourceIdentityHash(input.facts)).not.toBe(hash);
  });
  it("does not bind modified time, collection date, status or source prices; eligible state still live checked", () => {
    const input = fixture(); const plan = buildManualForHireHandoverPlan(input);
    Object.assign(input.facts, { sourceRefreshedAt: "2099-01-01", collectionDate: "2020-01-01", status: "IDLE",
      monthlyCostInclusive: 999, purchasePriceInclusive: 123, liftAndBookingFeesInclusive: 456 });
    expect(buildManualForHireHandoverPlan(input)).toEqual(plan);
    input.facts.status = "DEHIRED";
    expect(manualForHireSourceIdentityHash(input.facts)).toBe(plan.sourceIdentityHash);
    expect(() => buildManualForHireHandoverPlan(input)).toThrow(/status/);
  });
  it.each([
    ["PurchaseOrderID", "changed-id"], ["PurchaseOrderNumber", "HC1929-2"], ["Status", "BILLED"], ["CurrencyCode", "USD"],
    ["Description", "new header"], ["Date", "2026-02-01"], ["DueDate", "2026-03-01"], ["Reference", "changed"],
  ])("binds exact manual business field %s", (field, value) => {
    const input = fixture(); const hash = manualForHireEvidenceHash(input.evidence); input.evidence.manualPo[field] = value;
    expect(manualForHireEvidenceHash(input.evidence)).not.toBe(hash);
  });
  it.each(["Description", "ItemCode", "Quantity", "UnitAmount", "AccountCode", "TaxType", "LineAmount", "DiscountRate"])("binds exact manual line business field %s", (field) => {
    const input = fixture(); const hash = manualForHireEvidenceHash(input.evidence); hireLine(input)[field] = "changed";
    expect(manualForHireEvidenceHash(input.evidence)).not.toBe(hash);
  });
  it("binds tenant, expected contact, actual contact and completeness", () => {
    for (const mutate of [
      (e: ManualForHireEvidence) => { e.tenantId = "tenant-other"; },
      (e: ManualForHireEvidence) => { e.supplierContactId = "contact-other"; },
      (e: ManualForHireEvidence) => { e.manualPo.Contact.ContactID = "contact-other"; },
      (e: ManualForHireEvidence) => { e.complete = false; },
    ]) {
      const input = fixture(); const hash = manualForHireEvidenceHash(input.evidence); mutate(input.evidence);
      expect(manualForHireEvidenceHash(input.evidence)).not.toBe(hash);
    }
  });
  it("is independent of object key order, related PO ordering and API UpdatedDate metadata", () => {
    const input = fixture(); input.evidence.relatedPurchaseOrders = [otherPo(input, { id: "z-id" }), otherPo(input, { id: "a-id" })];
    const plan = buildManualForHireHandoverPlan(input);
    input.evidence = reverseObjectKeys(input.evidence); input.evidence.relatedPurchaseOrders.reverse();
    for (const po of [input.evidence.manualPo, ...input.evidence.relatedPurchaseOrders]) {
      po.UpdatedDateUTC = "/Date(9999999999999)/"; po.UpdatedDate = "2099-01-01"; po.updatedAt = "new";
      po.Contact.UpdatedDateUTC = "new"; po.LineItems[0].UpdatedDate = "new";
    }
    expect(buildManualForHireHandoverPlan(input)).toEqual(plan);
    expect(input.evidence.relatedPurchaseOrders.map((po) => po.PurchaseOrderID)).toEqual(["a-id", "z-id"]);
  });
  it("binds related scoped IDs, statuses, descriptions, contact and rate business changes", () => {
    for (const mutate of [
      (po: Record<string, any>) => { po.PurchaseOrderID = "different"; },
      (po: Record<string, any>) => { po.Status = "BILLED"; },
      (po: Record<string, any>) => { po.LineItems[0].Description += " changed"; },
      (po: Record<string, any>) => { po.Contact.ContactID = "other-contact"; },
      (po: Record<string, any>) => { po.LineItems[0].UnitAmount = 999; },
    ]) {
      const input = fixture(); input.evidence.relatedPurchaseOrders = [otherPo(input)];
      const hash = manualForHireEvidenceHash(input.evidence); mutate(input.evidence.relatedPurchaseOrders[0]);
      expect(manualForHireEvidenceHash(input.evidence)).not.toBe(hash);
    }
  });
  it("does not lock the manual historical rate into the next-period plan", () => {
    const input = fixture(); hireLine(input).UnitAmount = 98765.43;
    const plan = buildManualForHireHandoverPlan(input);
    expect(plan.nextPoNumber).toBe("HC1929-2");
    const live = buildRecurringForHirePo({ facts: input.facts, priorPeriodEnd: plan.coveredThrough, lastVerifiedExtensionSuffix: null,
      purchaseRate: 17.25, now: plan.nextPeriodStart });
    expect(live.document?.lineItems[0].unitAmount).toBe(17.25);
    expect(live.periodStart).toBe(plan.nextPeriodStart); expect(live.periodEnd).toBe(plan.nextPeriodEnd);
  });
  it("binds effectiveFrom while permitting different future baselines up to the same consecutive start", () => {
    const input = fixture(); input.effectiveFrom = "2026-11-13"; const first = buildManualForHireHandoverPlan(input);
    input.effectiveFrom = "2026-11-14"; const second = buildManualForHireHandoverPlan(input);
    expect(second.planHash).not.toBe(first.planHash);
    expect(second.xeroEvidenceHash).toBe(first.xeroEvidenceHash);
  });
});
