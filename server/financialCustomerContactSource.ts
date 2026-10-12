import { createHash } from "node:crypto";
import { describeVtigerFinancialModuleFields, retrieveCurrentVtigerFinancialRecord } from "./vtigerFinancialReadService";
import type { CustomerContactSource } from "./financialCustomerContactService";

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}
function recordId(value: string): string {
  return /^\d+x\d+$/i.test(value.trim()) ? value.trim() : "";
}
function normalName(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}
function sourceHash(source: Omit<CustomerContactSource, "sourceSnapshotHash">): string {
  return createHash("sha256").update(JSON.stringify({
    customerVtigerId: source.customerVtigerId,
    customerKind: source.customerKind,
    name: normalName(source.name).toLocaleLowerCase(),
    email: source.email?.trim().toLocaleLowerCase() ?? "",
    phone: source.phone?.replace(/\D/g, "") ?? "",
  })).digest("hex");
}

function uniqueFieldByLabel(fields: Array<{ name: string; label: string }>, label: string): string | null {
  const matches = fields.filter(field => field.label.trim().toLocaleLowerCase() === label.toLocaleLowerCase());
  return matches.length === 1 && matches[0]?.name ? matches[0].name : null;
}

/**
 * Reads the current linked customer and only metadata-proven Email/Mobile/Phone
 * fields. This is deliberately independent of browser previews and webhook body
 * values; returned contact data is used only by protected automatic execution.
 */
export async function readCurrentCustomerContactSource(input: {
  customerVtigerId: string;
  customerKind: "organisation" | "contact";
  expectedCustomerName: string;
}): Promise<CustomerContactSource> {
  const id = recordId(input.customerVtigerId);
  if (!id) throw new Error("Current VTiger customer reference is invalid.");
  const module = input.customerKind === "organisation" ? "Accounts" : "Contacts";
  const [metadata, record] = await Promise.all([
    describeVtigerFinancialModuleFields(module),
    retrieveCurrentVtigerFinancialRecord(id),
  ]);
  if (recordId(text(record.id)) !== id || metadata.name !== module) throw new Error("Current VTiger customer source could not be verified.");
  const name = input.customerKind === "organisation"
    ? normalName(text(record.accountname))
    : normalName([text(record.firstname), text(record.lastname)].filter(Boolean).join(" "));
  if (!name || normalName(input.expectedCustomerName).toLocaleLowerCase() !== name.toLocaleLowerCase()) {
    throw new Error("Current VTiger customer identity changed since invoice source evidence; no Xero contact will be created.");
  }
  const emailField = uniqueFieldByLabel(metadata.fields, "Email");
  const mobileField = uniqueFieldByLabel(metadata.fields, "Mobile");
  const phoneField = uniqueFieldByLabel(metadata.fields, "Phone");
  const email = emailField ? text(record[emailField]) || null : null;
  const phone = mobileField ? text(record[mobileField]) || null : phoneField ? text(record[phoneField]) || null : null;
  const source = { customerVtigerId: id, customerKind: input.customerKind, name, email, phone };
  return { ...source, sourceSnapshotHash: sourceHash(source) };
}
