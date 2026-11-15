import { describe, expect, it } from "vitest";
import {
  forHireExtensionReference,
  forHireInitialReference,
  parseForHireReferenceSuffix,
} from "./financialForHireNumbering";

describe("pure For Hire numbering", () => {
  it("preserves the default AP opening ordinal and approved HC1929 first extension", () => {
    expect(forHireInitialReference("C1929")).toBe("HC1929");
    expect(forHireExtensionReference("C1929", null)).toBe("HC1929-2");
    expect(forHireExtensionReference("C1929", null, "ap_initial_ordinal_one")).toBe("HC1929-2");
    expect(forHireExtensionReference("C1929", 1)).toBe("HC1929-2");
    expect(forHireExtensionReference("C1929", 2)).toBe("HC1929-3");
    expect(() => forHireExtensionReference("C1929", 0)).toThrow(/sequence/);
  });

  // Owner-confirmed HC1920 convention is explicitly legacy, not an AP-wide change.
  it.each([
    { predecessor: null, next: "HC1920-1" },
    { predecessor: 0, next: "HC1920-1" },
    { predecessor: 1, next: "HC1920-2" },
    { predecessor: 2, next: "HC1920-3" },
    { predecessor: 7, next: "HC1920-8" },
  ])("allocates the exact legacy successor $next from $predecessor", ({ predecessor, next }) => {
    expect(forHireExtensionReference("C1920", predecessor, "legacy_suffix_zero_initial")).toBe(next);
  });

  it.each([
    { reference: "HC1920", suffix: 0 },
    { reference: "HC1920-1", suffix: 1 },
    { reference: "HC1920-2", suffix: 2 },
    { reference: "HC1920-25", suffix: 25 },
  ])("parses the actual legacy suffix of $reference as $suffix without rewriting it", ({ reference, suffix }) => {
    expect(parseForHireReferenceSuffix("C1920", reference)).toBe(suffix);
    expect(reference).toBe(suffix === 0 ? "HC1920" : `HC1920-${suffix}`);
  });

  it.each([
    "", "HC1921", "HC1921-1", "HC19200-1", "H1920", "hc1920-1", "HC01920-1",
    "HC1920-", "HC1920-0", "HC1920-00", "HC1920-01", "HC1920-02", "HC1920--1",
    "HC1920-+1", "HC1920-1.0", "HC1920-1.5", "HC1920-1e2", "HC1920-1x",
    "HC1920-1/other", "HC1920- 1", " HC1920-1", "HC1920-1 ", "HC1920-1\n",
    "HC1920-9007199254740992", "HC1920-9007199254740993", "HC1920-99999999999999999999999",
    null, undefined, 1, {},
  ])("rejects non-canonical, unsafe or wrong-control reference %j", (reference) => {
    expect(parseForHireReferenceSuffix("C1920", reference)).toBeNull();
  });

  it.each([
    "", "1920", "c1920", "HC1920", "C0", "C00", "C01920", "C-1920", "C+1920",
    "C1920.0", "C1920.5", "C1e3", "C1920x", "C1920/other", " C1920", "C1920 ", "C1920\n",
    "C9007199254740992", "C9007199254740993", null, undefined, 1920, {},
  ])("rejects invalid control %j instead of normalizing a business number", (control) => {
    expect(() => forHireInitialReference(control as any)).toThrow(/canonical/);
    expect(() => forHireExtensionReference(control as any, null)).toThrow(/canonical/);
    expect(() => parseForHireReferenceSuffix(control as any, "HC1920")).toThrow(/canonical/);
  });

  it.each([
    -0, -1, -2, 0.5, 1.5, NaN, Infinity, -Infinity,
    Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1,
    "0", "1", "01", "1.0", "-1", undefined, true, {},
  ])("rejects an invalid predecessor or unsafe successor %j in both conventions", (suffix) => {
    for (const convention of ["ap_initial_ordinal_one", "legacy_suffix_zero_initial"] as const) {
      expect(() => forHireExtensionReference("C1920", suffix as any, convention)).toThrow(/sequence/);
    }
  });

  it("accepts the maximum safe reference for reading, but refuses its unsafe successor", () => {
    const maximum = Number.MAX_SAFE_INTEGER;
    const reference = `HC1920-${maximum}`;
    expect(parseForHireReferenceSuffix("C1920", reference)).toBe(maximum);
    expect(forHireExtensionReference("C1920", maximum - 1, "legacy_suffix_zero_initial")).toBe(reference);
    expect(forHireExtensionReference("C1920", maximum - 1)).toBe(reference);
    expect(() => forHireExtensionReference("C1920", maximum, "legacy_suffix_zero_initial")).toThrow(/safe next suffix/);
    expect(forHireInitialReference(`C${maximum}`)).toBe(`HC${maximum}`);
  });

  it.each([null, "legacy", "", 0])("rejects an unknown runtime convention %j instead of falling back", (convention) => {
    expect(() => forHireExtensionReference("C1920", null, convention as any)).toThrow(/convention/);
  });
});
