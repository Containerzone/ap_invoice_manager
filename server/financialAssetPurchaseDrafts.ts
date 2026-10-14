import { createHash } from "node:crypto";
import type { FinancialLineItem, ProposedFinancialDocument } from "./financialWorkflowEngine";

export const ASSET_PURCHASE_ACCOUNT_CODE = "322" as const;
export const ASSET_PURCHASE_ITEM_CODES = { 20: "20' Sale", 40: "40' Sale" } as const;
export const ASSET_PURCHASE_RULES_VERSION = "container-control-asset-v2-sale-items-placeholders" as const;
export const ASSET_PURCHASE_RULES_HASH = createHash("sha256").update(ASSET_PURCHASE_RULES_VERSION).digest("hex");

export type AssetPurchaseContainerControlFacts = {
  recordId: string;
  controlNumber: string;
  acquisition: string;
  status: string;
  containerNumber: string;
  containerType: string;
  grade: string;
  collectionDepot: string;
  supplierVtigerId: string;
  supplierName: string;
  purchasePriceInclusive: number | null;
  purchaseDate: string;
  sourceRefreshedAt: string | null;
};

export type AssetPurchasePoPreview = {
  eligible: boolean;
  holdReason: string | null;
  proposedPoNumber: string | null;
  document: ProposedFinancialDocument | null;
};

const GST_RATE = 0.1;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

function normal(value: unknown): string {
  return text(value).toUpperCase().replace(/\s+/g, " ");
}

function money(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function parseDate(value: string): Date | null {
  const direct = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const reversed = value.match(/^(\d{2})[-/](\d{2})[-/](\d{4})$/);
  const iso = direct ? value : reversed ? `${reversed[3]}-${reversed[2]}-${reversed[1]}` : "";
  if (!iso) return null;
  const result = new Date(`${iso}T00:00:00.000Z`);
  return Number.isNaN(result.getTime()) ? null : result;
}

function containerFeet(value: string): 20 | 40 | null {
  const normalized = normal(value);
  if (/^20\b/.test(normalized) || normalized.includes("20 FOOT")) return 20;
  if (/^40\b/.test(normalized) || normalized.includes("40 FOOT")) return 40;
  return null;
}

function operationalDescription(facts: AssetPurchaseContainerControlFacts): string {
  return [facts.containerType, facts.grade].filter(Boolean).join(" ");
}

function line(facts: AssetPurchaseContainerControlFacts, amountExGst: number): FinancialLineItem {
  return {
    itemCode: ASSET_PURCHASE_ITEM_CODES[containerFeet(facts.containerType)!],
    description: operationalDescription(facts),
    quantity: 1,
    unitAmount: amountExGst,
    lineAmount: amountExGst,
    accountCode: ASSET_PURCHASE_ACCOUNT_CODE,
    taxRate: 10,
    gstTreatment: "GST_EXCLUSIVE",
  };
}

/**
 * Builds exactly one Asset purchase-order proposal. The event receiver always
 * re-reads this current source; webhook body fields never set price, supplier
 * or description. Asset is the only permitted acquisition family. VTiger's
 * current picklist serializes that value as ASSETT, so the compatibility alias
 * is accepted without broadening the branch to For Hire or Customer Sale.
 */
export function buildAssetPurchasePo(facts: AssetPurchaseContainerControlFacts): AssetPurchasePoPreview {
  if (!new Set(["ASSET", "ASSETT"]).has(normal(facts.acquisition))) {
    return { eligible: false, holdReason: "Container Control acquisition is not ASSET.", proposedPoNumber: null, document: null };
  }
  if (normal(facts.status) !== "REQUEST") {
    return { eligible: false, holdReason: "Asset PO trigger requires Container Control status REQUEST.", proposedPoNumber: null, document: null };
  }
  if (!facts.recordId || !facts.controlNumber) {
    return { eligible: false, holdReason: "Container Control ID and business number are required.", proposedPoNumber: null, document: null };
  }
  if (!facts.containerNumber) {
    return { eligible: false, holdReason: "Container ID is required for the Asset PO description.", proposedPoNumber: null, document: null };
  }
  const feet = containerFeet(facts.containerType);
  if (!feet) {
    return { eligible: false, holdReason: "Container Type must identify a supported 20 or 40 foot container.", proposedPoNumber: null, document: null };
  }
  if (!facts.supplierVtigerId || !facts.supplierName) {
    return { eligible: false, holdReason: "Assigned Supplier Name reference is required.", proposedPoNumber: null, document: null };
  }
  if (facts.purchasePriceInclusive === null || !Number.isFinite(facts.purchasePriceInclusive) || facts.purchasePriceInclusive <= 0) {
    return { eligible: false, holdReason: "Purchase Price INCL GST must be a positive amount.", proposedPoNumber: null, document: null };
  }
  const purchaseDate = parseDate(facts.purchaseDate);
  if (!purchaseDate) {
    return { eligible: false, holdReason: "Purchase Date is missing or invalid.", proposedPoNumber: null, document: null };
  }

  const amountExGst = money(facts.purchasePriceInclusive / (1 + GST_RATE));
  const lineItem = line(facts, amountExGst);
  const poNumber = `A${facts.controlNumber}`;
  return {
    eligible: true,
    holdReason: null,
    proposedPoNumber: poNumber,
    document: {
      documentFamily: "purchase_order",
      documentType: "asset_purchase",
      proposedAction: "create_draft",
      proposedDocumentNumber: poNumber,
      reference: facts.controlNumber,
      partyName: facts.supplierName,
      partySourceId: null,
      accountCode: ASSET_PURCHASE_ACCOUNT_CODE,
      gstTreatment: "GST_EXCLUSIVE",
      currency: "AUD",
      subtotal: amountExGst,
      taxAmount: money(amountExGst * GST_RATE),
      total: money(amountExGst * (1 + GST_RATE)),
      issueDate: purchaseDate,
      dueDate: null,
      lineItems: [lineItem],
      sourceWorkflow: "container_control_acquisition",
      sourceRecordId: facts.recordId,
      validationStatus: "valid",
    },
  };
}
