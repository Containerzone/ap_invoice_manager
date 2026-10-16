export type BusinessReferenceMap = Readonly<Record<string, string | null>>;

const tokenPattern = () => /(?<![A-Za-z0-9])(?:5|79)x\d{1,12}(?![A-Za-z0-9])/gi;
export const normalizeDisplayRecordId = (id: string) => id.toLowerCase();

/** Technical suffixes are not business numbers. Never derive D/C numbers from them. */
export function collectDisplayRecordIds(value: unknown): string[] {
  const found = new Set<string>();
  const seen = new WeakSet<object>();
  const visit = (item: unknown) => {
    if (typeof item === "string") {
      Array.from(item.matchAll(tokenPattern())).forEach(match => found.add(normalizeDisplayRecordId(match[0])));
    } else if (item && typeof item === "object" && !(item instanceof Date)) {
      if (seen.has(item)) return;
      seen.add(item);
      Object.values(item).forEach(visit);
    }
  };
  visit(value);
  return Array.from(found).sort();
}

export function formatBusinessDisplayText(value: string, references: BusinessReferenceMap = {}): string {
  return value.replace(tokenPattern(), (id) => {
    const normalized = normalizeDisplayRecordId(id);
    const number = references[normalized];
    const expected = normalized.startsWith("5x") ? /^D\d{1,12}$/i : /^C\d{1,12}$/i;
    if (number && expected.test(number)) return number.toUpperCase();
    const kind = normalized.startsWith("5x") ? "Deal" : "Container Control";
    return Object.prototype.hasOwnProperty.call(references, normalized)
      ? `[${kind} reference unavailable]`
      : `[${kind} reference loading]`;
  });
}

/** Display projection only: immutable source payloads are never mutated. */
export function formatBusinessDisplayJson(value: unknown, references: BusinessReferenceMap = {}, space = 2): string {
  return formatBusinessDisplayText(JSON.stringify(value, null, space) ?? "", references);
}
