export type ForHireNumberingConvention = "ap_initial_ordinal_one" | "legacy_suffix_zero_initial";

/** Pure numbering only: no document lookup, renaming, allocation persistence or writes. */
function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function canonicalPositiveInteger(value: string): number | null {
  if (!/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return positiveSafeInteger(parsed) && String(parsed) === value ? parsed : null;
}

/** Requires an exact C<positive safe integer>; never trims or rewrites a business number. */
export function forHireInitialReference(controlNumber: string): string {
  if (typeof controlNumber !== "string" || controlNumber !== controlNumber.trim()
    || !controlNumber.startsWith("C") || canonicalPositiveInteger(controlNumber.slice(1)) === null) {
    throw new Error("For Hire reference requires an exact canonical C-digits control number with a positive safe integer.");
  }
  return `H${controlNumber}`;
}

/**
 * Parses an existing reference without renaming it: unsuffixed = 0, -1 = 1,
 * -2 = 2, etc. Returns null for a non-canonical or wrong-control reference.
 * A maximum-safe suffix is readable, but cannot allocate a safe successor.
 * Invalid control numbers throw. This parser does not verify document evidence
 * or select a numbering convention; 0 is usable only with explicit legacy mode.
 */
export function parseForHireReferenceSuffix(controlNumber: string, reference: unknown): number | null {
  const initial = forHireInitialReference(controlNumber);
  if (reference === initial) return 0;
  if (typeof reference !== "string" || reference !== reference.trim() || !reference.startsWith(`${initial}-`)) return null;
  return canonicalPositiveInteger(reference.slice(initial.length + 1));
}

/**
 * Returns only the consecutive extension reference; callers must preflight it.
 * Default AP convention is unchanged: null -> -2, 1 -> -2, 2 -> -3.
 * Explicit legacy convention: null/0 -> -1, 1 -> -2, 2 -> -3.
 * Positive suffixes and their successors must be safe integers. Numeric 0 is
 * accepted only for an explicitly legacy unsuffixed initial. No gap bypass,
 * document evidence verification, or approval is performed by this helper.
 */
export function forHireExtensionReference(
  controlNumber: string,
  lastVerifiedExtensionSuffix: number | null,
  numberingConvention: ForHireNumberingConvention = "ap_initial_ordinal_one",
): string {
  const initial = forHireInitialReference(controlNumber);
  if (numberingConvention !== "ap_initial_ordinal_one" && numberingConvention !== "legacy_suffix_zero_initial") {
    throw new Error("For Hire numbering convention is invalid.");
  }
  const legacyInitial = numberingConvention === "legacy_suffix_zero_initial"
    && (lastVerifiedExtensionSuffix === null || Object.is(lastVerifiedExtensionSuffix, 0));
  if (!legacyInitial && lastVerifiedExtensionSuffix !== null && !positiveSafeInteger(lastVerifiedExtensionSuffix)) {
    throw new Error("For Hire extension sequence requires a positive safe integer suffix (or 0 for an explicitly legacy initial).");
  }
  const next = legacyInitial ? 1 : lastVerifiedExtensionSuffix === null ? 2 : lastVerifiedExtensionSuffix + 1;
  if (!positiveSafeInteger(next)) throw new Error("For Hire extension sequence has no safe next suffix.");
  return `${initial}-${next}`;
}
