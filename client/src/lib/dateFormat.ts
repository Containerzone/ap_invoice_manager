export type DateDisplayValue = Date | string | null | undefined;

const SYDNEY_TIME_ZONE = "Australia/Sydney";
const dateOptions: Intl.DateTimeFormatOptions = {
  timeZone: SYDNEY_TIME_ZONE,
  day: "2-digit",
  month: "2-digit",
  year: "2-digit",
};
const dateTimeOptions: Intl.DateTimeFormatOptions = {
  ...dateOptions,
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
};

function validDate(value: DateDisplayValue): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Formats a user-visible financial or operational date in Australia/Sydney. */
export function formatSydneyDate(value: DateDisplayValue, fallback = "—"): string {
  const date = validDate(value);
  return date ? date.toLocaleDateString("en-AU", dateOptions) : fallback;
}

/** Formats an operational timestamp with its Sydney date first. */
export function formatSydneyDateTime(value: DateDisplayValue, fallback = "—"): string {
  const date = validDate(value);
  return date ? date.toLocaleString("en-AU", dateTimeOptions) : fallback;
}
