import { describe, expect, it } from "vitest";
import {
  resolveExtractedPoNumbers,
  resolveInvoicePoNumbers,
  resolvePoNumbersFromLine,
} from "./poNumberResolution";

describe("authoritative PO number resolution", () => {
  it("uses a structured line PO without also treating the D job number in custRef as a PO", () => {
    expect(resolvePoNumbersFromLine({
      poNumber: "AD702840",
      custRef: "D702840/#AD702840",
      description: "40ft Sideloader",
    })).toEqual(["AD702840"]);
  });

  it("uses the explicit #PO token in a customer reference before the preceding job/deal number", () => {
    expect(resolvePoNumbersFromLine({
      poNumber: null,
      custRef: "D702840/#AD702840",
      description: "40ft Sideloader",
    })).toEqual(["AD702840"]);
  });

  it("uses a deliberately cleared line PO rather than scanning stale raw reference text", () => {
    expect(resolvePoNumbersFromLine({
      poNumber: null,
      poNumberEdited: true,
      custRef: "D702840/#AD702840",
      description: "40ft Sideloader",
    })).toEqual([]);
  });

  it("uses a manually saved header list as authoritative even when it is empty", () => {
    const base = {
      extractedPoNumbers: ["AD702840"],
      extractedPoNumber: "AD702840",
      lineItems: [{ poNumber: "AD702840", custRef: "D702840/#AD702840" }],
    };
    expect(resolveInvoicePoNumbers({ ...base, poNumbersManuallyEdited: true, extractedPoNumbers: [] })).toEqual([]);
    expect(resolveInvoicePoNumbers({ ...base, poNumbersManuallyEdited: true, extractedPoNumbers: ["BD702841-2"] })).toEqual(["BD702841-2"]);
  });

  it("uses line-level source priority when no manual header override is present", () => {
    expect(resolveInvoicePoNumbers({
      extractedPoNumbers: ["AD702840"],
      extractedPoNumber: "AD702840",
      lineItems: [{ poNumber: "AD702840", custRef: "D702840/#AD702840" }],
    })).toEqual(["AD702840"]);
  });

  it("returns only the intended structured reference during initial extraction", () => {
    expect(resolveExtractedPoNumbers({
      poNumber: "AD702840",
      lineItems: [{ poNumber: "AD702840", custRef: "D702840/#AD702840" }],
    })).toEqual(["AD702840"]);
  });
});
