export type PoBearingLine = {
  poNumber?: string | null;
  poNumberEdited?: boolean | null;
  custRef?: string | null;
  description?: string | null;
};

// Two accepted shapes:
//  1. ContainerZone references: 1–2 letters + 4–6 digits, optional "-n" suffix (AD702840, HC1860-2)
//  2. Xero default-format numbers: "PO-" + 4+ digits (PO-0255)
const PO_TOKEN_SOURCE = "(?:PO-\\d{4,}|[A-Z]{1,2}\\d{4,6}(?:-\\d+)?)";
export const PO_TOKEN_PATTERN = new RegExp(`\\b(${PO_TOKEN_SOURCE})\\b`, "g");
const EXACT_PO_TOKEN_PATTERN = new RegExp(`^${PO_TOKEN_SOURCE}$`);
const HASH_TAGGED_PO_PATTERN = new RegExp(`#(${PO_TOKEN_SOURCE})`, "g");

export function normalizePoNumber(value: string | null | undefined): string | null {
  // Tolerate "PO 0255" / "PO0255" variants of the Xero default format.
  const normalized = (value?.trim().toUpperCase() ?? "").replace(/^PO[\s-]*(\d{4,})$/, "PO-$1");
  return EXACT_PO_TOKEN_PATTERN.test(normalized) ? normalized : null;
}

function uniquePoNumbers(values: Array<string | null | undefined>): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizePoNumber(value);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result;
}

function matchedPoNumbers(value: string | null | undefined, pattern: RegExp): string[] {
  if (!value) return [];
  const matches = Array.from(value.matchAll(pattern), (match) => match[1] ?? match[0]);
  return uniquePoNumbers(matches);
}

/**
 * Resolves PO references for a single invoice line with strict source priority.
 * A manually edited line value, including a deliberately cleared value, always
 * wins. Otherwise, a structured extraction wins. In references such as
 * "D702840/#AD702840", the explicit #PO token wins over the preceding job/deal
 * ID, preventing it from being treated as a second PO.
 */
export function resolvePoNumbersFromLine(line: PoBearingLine): string[] {
  if (line.poNumberEdited) return uniquePoNumbers([line.poNumber]);

  const structured = normalizePoNumber(line.poNumber);
  if (structured) return [structured];

  const taggedInCustRef = matchedPoNumbers(line.custRef, HASH_TAGGED_PO_PATTERN);
  if (taggedInCustRef.length > 0) return taggedInCustRef;

  const fromCustRef = matchedPoNumbers(line.custRef, PO_TOKEN_PATTERN);
  if (fromCustRef.length > 0) return fromCustRef;

  return matchedPoNumbers(line.description, PO_TOKEN_PATTERN);
}

/**
 * Chooses the authoritative invoice PO list. A saved manual header list is
 * intentionally authoritative even when empty, so removed OCR references can
 * never reappear from raw invoice text during verification or approval.
 */
export function resolveInvoicePoNumbers(input: {
  poNumbersManuallyEdited?: boolean | null;
  extractedPoNumbers?: string[] | null;
  extractedPoNumber?: string | null;
  lineItems: PoBearingLine[];
}): string[] {
  if (input.poNumbersManuallyEdited) {
    return uniquePoNumbers(input.extractedPoNumbers ?? []);
  }

  const fromLines = uniquePoNumbers(input.lineItems.flatMap(resolvePoNumbersFromLine));
  if (fromLines.length > 0) return fromLines;

  const fromHeaderList = uniquePoNumbers(input.extractedPoNumbers ?? []);
  if (fromHeaderList.length > 0) return fromHeaderList;

  return uniquePoNumbers([input.extractedPoNumber]);
}

/** Uses the same safe per-line source priority during initial extraction. */
export function resolveExtractedPoNumbers(input: {
  poNumber?: string | null;
  lineItems?: PoBearingLine[] | null;
}): string[] {
  const fromLines = uniquePoNumbers((input.lineItems ?? []).flatMap(resolvePoNumbersFromLine));
  if (fromLines.length > 0) return fromLines;
  return uniquePoNumbers([input.poNumber]);
}
