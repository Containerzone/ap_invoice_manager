/**
 * Vtiger → Xero Purchase Order Creation Service
 *
 * Receives a parsed Vtiger webhook payload (Deals module, Stage 1 trigger),
 * maps each non-zero cost field to a Xero Draft PO, and creates them.
 *
 * PO Number convention:
 *   - Most carriers: [PREFIX][D][DEAL_NUMBER]  e.g. AD702118, BD702118, DD702118
 *   - Pacific National: P[DEAL_NUMBER]          e.g. P702118  (no D)
 *   - Hub Transfer 2:   TD[DEAL_NUMBER]-2       e.g. TD702118-2
 *
 * All amounts are GST-exclusive. POs are created with LineAmountTypes = "EXCLUSIVE".
 */

import axios from "axios";
import { createXeroIdempotencyKey, findOrCreateXeroContact } from "./xeroService";
import {
  invalidateXeroCache,
  runCachedXeroGet,
  runXeroRequest,
  XERO_CACHE_TTL,
} from "./xeroRequestManager";

const XERO_API_BASE = "https://api.xero.com/api.xro/2.0";

// ─── Field mapping ────────────────────────────────────────────────────────────

/**
 * Maps each Vtiger webhook field name to its PO configuration.
 *
 * poPrefix:    prefix letters before the deal number
 * includeD:    if true, insert "D" between prefix and deal digits → e.g. "AD702118"
 *              if false, no D → e.g. "P702118"
 * suffix:      optional suffix appended after the full PO number → e.g. "-2"
 * supplier:    Xero contact name to use
 * accountCode: Xero account code
 * description: line item description (falls back to field label if blank)
 */
interface PoFieldConfig {
  poPrefix: string;
  includeD: boolean;
  suffix?: string;
  supplier: string;
  accountCode: string;
  description: string;
}

// Vtiger sends field names with inconsistent casing/spacing — we normalise to lowercase trimmed keys
const FIELD_MAP: Record<string, PoFieldConfig> = {
  // Empty Delivery (A)
  "cf_quotes_emptydelivery": {
    poPrefix: "A",
    includeD: true,
    supplier: "CONTAINERZONE",
    accountCode: "310",
    description: "Empty Container Delivery",
  },
  // Full Collection (B)
  "cf_quotes_fullcollection": {
    poPrefix: "B",
    includeD: true,
    supplier: "CONTAINERZONE",
    accountCode: "310",
    description: "Full Container Collection",
  },
  // Pacific National Rail (P) — no D
  "pn rail cost": {
    poPrefix: "P",
    includeD: false,
    supplier: "Pacific National",
    accountCode: "310",
    description: "Pacific National Rail Cost",
  },
  // Full Container Delivery (D)
  "fullcontainerdeliveryd": {
    poPrefix: "D",
    includeD: true,
    supplier: "CONTAINERZONE",
    accountCode: "310",
    description: "Full Container Delivery",
  },
  // Empty Dehire (E)
  "empty dehire e": {
    poPrefix: "E",
    includeD: true,
    supplier: "CONTAINERZONE",
    accountCode: "310",
    description: "Empty Container Dehire",
  },
  // Straitlink Bass Straight (SL) — no D between prefix and digits → SL702118
  "straitlinkbassstraight": {
    poPrefix: "SL",
    includeD: false,
    supplier: "Straitlink",
    accountCode: "310",
    description: "Straitlink Bass Straight",
  },
  // Tasmanian Rail (TR) — no D between prefix and digits → TR702118
  "tasmanianrail": {
    poPrefix: "TR",
    includeD: false,
    supplier: "Tasmanian Railway",
    accountCode: "310",
    description: "Tasmanian Rail Cost",
  },
  // Aurizon Rail (AZ) — no D between prefix and digits → AZ702118
  "aurizon rail": {
    poPrefix: "AZ",
    includeD: false,
    supplier: "Aurizon",
    accountCode: "310",
    description: "Aurizon Rail Cost",
  },
  // Hub Transfer (T)
  "hub transfrer t": {
    poPrefix: "T",
    includeD: true,
    supplier: "CONTAINERZONE",
    accountCode: "310",
    description: "Hub Transfer",
  },
  // Hub Transfer 2 (T-2)
  "hub transfrer t2": {
    poPrefix: "T",
    includeD: true,
    suffix: "-2",
    supplier: "CONTAINERZONE",
    accountCode: "310",
    description: "Hub Transfer 2",
  },
  // Regional Connect (RC) — no D between prefix and digits → RC702118
  "regional connect": {
    poPrefix: "RC",
    includeD: false,
    supplier: "CONTAINERZONE",
    accountCode: "310",
    description: "Regional Connect",
  },
  // Transport to Storage (J)
  "transport to storage": {
    poPrefix: "J",
    includeD: true,
    supplier: "CONTAINERZONE",
    accountCode: "310",
    description: "Transport to Storage",
  },
  // Storage per week (G)
  "storage pw": {
    poPrefix: "G",
    includeD: true,
    supplier: "CONTAINERZONE",
    accountCode: "310", // storage fees — override if needed
    description: "Storage per Week",
  },
  // Insurance (I)
  "insurance": {
    poPrefix: "I",
    includeD: true,
    supplier: "CONTAINERZONE",
    accountCode: "310",
    description: "Insurance",
  },
};

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PoCreationResult {
  poNumber: string;
  prefix: string;
  amountExclGst: number;
  supplier: string;
  accountCode: string;
  description: string;
  xeroPoId: string | null;
  xeroPoNumber: string | null;
  status: "created" | "skipped" | "error" | "duplicate";
  error?: string;
}

export interface ProcessWebhookResult {
  dealId: string;
  dealNumber: string;
  poResults: PoCreationResult[];
  overallStatus: "completed" | "partial" | "failed";
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Normalise a Vtiger field name to a consistent lowercase trimmed key
 * for matching against FIELD_MAP.
 */
function normaliseKey(raw: string): string {
  return raw.toLowerCase().trim().replace(/\s+/g, " ");
}

/**
 * Build the Xero PO number from the deal number and field config.
 * Deal number arrives as "D702118" — we extract the numeric part.
 */
function buildPoNumber(dealNumber: string, cfg: PoFieldConfig): string {
  // Strip leading "D" from deal number to get the digits
  const digits = dealNumber.replace(/^D/i, "");
  if (cfg.includeD) {
    return `${cfg.poPrefix}D${digits}${cfg.suffix ?? ""}`;
  } else {
    return `${cfg.poPrefix}${digits}${cfg.suffix ?? ""}`;
  }
}

/**
 * Parse a currency string like "$618.45" or "618.45" to a number.
 * Returns null if blank or zero.
 */
function parseCurrency(raw: string | undefined | null): number | null {
  if (!raw || raw.trim() === "") return null;
  const cleaned = raw.replace(/[$,\s]/g, "");
  const val = parseFloat(cleaned);
  if (isNaN(val) || val <= 0) return null;
  return val;
}

// ─── Xero PO creation ────────────────────────────────────────────────────────

async function getValidAccessToken(
  clientId: string,
  clientSecret: string
): Promise<{ token: string; tenantId: string } | null> {
  // Use the same getXeroToken helper from db.ts (token is stored by tenant, not by clientId)
  const { getXeroToken, upsertXeroToken } = await import("./db");
  const stored = await getXeroToken();
  if (!stored) return null;

  // Check if token is still valid (5 min buffer)
  if (stored.expiresAt && stored.expiresAt.getTime() > Date.now() + 5 * 60 * 1000) {
    return { token: stored.accessToken, tenantId: stored.tenantId };
  }

  // Refresh
  try {
    const params = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: stored.refreshToken,
    });
    const resp = await axios.post("https://identity.xero.com/connect/token", params.toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      auth: { username: clientId, password: clientSecret },
    });
    const { access_token, refresh_token, expires_in } = resp.data;
    const expiresAt = new Date(Date.now() + expires_in * 1000);
    await upsertXeroToken({
      tenantId: stored.tenantId,
      tenantName: stored.tenantName ?? "",
      accessToken: access_token,
      refreshToken: refresh_token ?? stored.refreshToken,
      expiresAt,
      scope: stored.scope ?? "",
      connectedBy: stored.connectedBy,
    });
    return { token: access_token, tenantId: stored.tenantId };
  } catch (err: any) {
    console.error("[Vtiger PO] Token refresh failed:", err?.response?.data ?? err.message);
    return null;
  }
}

async function checkPoExists(
  poNumber: string,
  auth: { token: string; tenantId: string }
): Promise<string | null> {
  try {
    const data = await runCachedXeroGet<any>(
      auth,
      `purchase-order:${poNumber.trim().toUpperCase()}`,
      XERO_CACHE_TTL.purchaseOrder,
      () => axios.get(`${XERO_API_BASE}/PurchaseOrders/${encodeURIComponent(poNumber)}`, {
        headers: {
          Authorization: `Bearer ${auth.token}`,
          "Xero-tenant-id": auth.tenantId,
          Accept: "application/json",
        },
      }),
    );
    const list = data?.PurchaseOrders ?? [];
    return list.length > 0 ? list[0].PurchaseOrderID : null;
  } catch (error: any) {
    if (error?.response?.status === 404) return null;
    throw error;
  }
}

async function createXeroDraftPO(opts: {
  poNumber: string;
  description: string;
  amountExclGst: number;
  accountCode: string;
  supplierName: string;
  auth: { token: string; tenantId: string };
  clientId: string;
  clientSecret: string;
}): Promise<{ xeroPoId: string; xeroPoNumber: string }> {
  // Find or create the Xero contact
  const contactId = await findOrCreateXeroContact(
    opts.supplierName,
    null,
    null,
    opts.clientId,
    opts.clientSecret
  );

  const contactPayload = contactId
    ? { ContactID: contactId }
    : { Name: opts.supplierName };

  const body = {
    PurchaseOrders: [
      {
        Type: "PURCHASEORDER",
        Contact: contactPayload,
        PurchaseOrderNumber: opts.poNumber,
        Status: "DRAFT",
        LineAmountTypes: "Exclusive", // GST exclusive — Xero requires title-case (not EXCLUSIVE)
        LineItems: [
          {
            Description: opts.description,
            Quantity: 1,
            UnitAmount: opts.amountExclGst,
            AccountCode: opts.accountCode,
            TaxType: "INPUT", // GST on Expenses
          },
        ],
      },
    ],
  };

  let resp: any;
  try {
    resp = await runXeroRequest(
      opts.auth,
      `create PO ${opts.poNumber}`,
      () => axios.post(`${XERO_API_BASE}/PurchaseOrders`, body, {
        headers: {
          Authorization: `Bearer ${opts.auth.token}`,
          "Xero-tenant-id": opts.auth.tenantId,
          "Content-Type": "application/json",
          Accept: "application/json",
          "Idempotency-Key": createXeroIdempotencyKey("vtiger-po", body),
        },
      }),
    );
    await invalidateXeroCache(opts.auth, `purchase-order:${opts.poNumber.trim().toUpperCase()}`);
  } catch (err: any) {
    // Extract detailed Xero error from HTTP 4xx/5xx response body
    const xeroData = err?.response?.data;
    if (xeroData) {
      const elements: any[] = xeroData.Elements ?? [];
      const valMsgs: string[] = [];
      for (const el of elements) {
        const errs: any[] = el.ValidationErrors ?? [];
        errs.forEach((e: any) => { if (e.Message) valMsgs.push(e.Message); });
      }
      const topMsg: string | undefined = xeroData.Message;
      const detail = valMsgs.length > 0 ? valMsgs.join("; ") : topMsg ?? JSON.stringify(xeroData);
      console.error(`[Vtiger PO] createXeroDraftPO HTTP error for ${opts.poNumber}:`, detail);
      throw new Error(`Xero PO creation failed: ${detail}`);
    }
    throw err;
  }

  const created = resp.data?.PurchaseOrders?.[0];
  if (!created || created.HasErrors) {
    const errs = created?.ValidationErrors?.map((e: any) => e.Message).join("; ") ?? "Unknown error";
    throw new Error(`Xero PO creation failed: ${errs}`);
  }

  return {
    xeroPoId: created.PurchaseOrderID,
    xeroPoNumber: created.PurchaseOrderNumber,
  };
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export async function processVtigerWebhook(
  payload: Record<string, any>
): Promise<ProcessWebhookResult> {
  const clientId = process.env.XERO_CLIENT_ID;
  const clientSecret = process.env.XERO_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("XERO_CLIENT_ID or XERO_CLIENT_SECRET not configured");
  }

  // Extract deal number — Vtiger sends "D702118" with a trailing space sometimes
  const rawDealId =
    payload["deal id "] ??
    payload["deal id"] ??
    payload["deal_id"] ??
    payload["potentialname"] ??
    null;

  if (!rawDealId) {
    throw new Error("No deal ID found in webhook payload");
  }

  const dealNumber = String(rawDealId).trim(); // e.g. "D702118"
  const dealDigits = dealNumber.replace(/^D/i, ""); // e.g. "702118"

  console.log(`[Vtiger PO] Processing deal: ${dealNumber}`);

  // Get Xero auth token
  const auth = await getValidAccessToken(clientId, clientSecret);
  if (!auth) {
    throw new Error("Could not obtain valid Xero access token — please re-authenticate with Xero");
  }

  const results: PoCreationResult[] = [];

  // Iterate over all payload fields and match to FIELD_MAP
  for (const [rawKey, rawValue] of Object.entries(payload)) {
    const normKey = normaliseKey(rawKey);

    // Skip meta fields
    if (normKey === "deal id" || normKey === "deal id " || normKey === "total transport cost") continue;

    const cfg = FIELD_MAP[normKey];
    if (!cfg) {
      console.log(`[Vtiger PO] No mapping for field "${rawKey}" (normalised: "${normKey}") — skipping`);
      continue;
    }

    const amount = parseCurrency(String(rawValue));
    if (amount === null) {
      console.log(`[Vtiger PO] Skipping "${rawKey}" — zero or blank amount`);
      results.push({
        poNumber: buildPoNumber(dealNumber, cfg),
        prefix: cfg.poPrefix,
        amountExclGst: 0,
        supplier: cfg.supplier,
        accountCode: cfg.accountCode,
        description: cfg.description,
        xeroPoId: null,
        xeroPoNumber: null,
        status: "skipped",
      });
      continue;
    }

    const poNumber = buildPoNumber(dealNumber, cfg);
    console.log(`[Vtiger PO] Creating PO ${poNumber} for ${cfg.supplier} — $${amount} excl. GST`);

    // Check if PO already exists in Xero
    const existingId = await checkPoExists(poNumber, auth);
    if (existingId) {
      console.log(`[Vtiger PO] PO ${poNumber} already exists in Xero (${existingId}) — skipping`);
      results.push({
        poNumber,
        prefix: cfg.poPrefix,
        amountExclGst: amount,
        supplier: cfg.supplier,
        accountCode: cfg.accountCode,
        description: cfg.description,
        xeroPoId: existingId,
        xeroPoNumber: poNumber,
        status: "duplicate",
      });
      continue;
    }

    try {
      const { xeroPoId, xeroPoNumber } = await createXeroDraftPO({
        poNumber,
        description: cfg.description,
        amountExclGst: amount,
        accountCode: cfg.accountCode,
        supplierName: cfg.supplier,
        auth,
        clientId,
        clientSecret,
      });

      console.log(`[Vtiger PO] Created PO ${xeroPoNumber} (${xeroPoId})`);
      results.push({
        poNumber,
        prefix: cfg.poPrefix,
        amountExclGst: amount,
        supplier: cfg.supplier,
        accountCode: cfg.accountCode,
        description: cfg.description,
        xeroPoId,
        xeroPoNumber,
        status: "created",
      });
    } catch (err: any) {
      console.error(`[Vtiger PO] Failed to create PO ${poNumber}:`, err.message);
      results.push({
        poNumber,
        prefix: cfg.poPrefix,
        amountExclGst: amount,
        supplier: cfg.supplier,
        accountCode: cfg.accountCode,
        description: cfg.description,
        xeroPoId: null,
        xeroPoNumber: null,
        status: "error",
        error: err.message,
      });
    }
  }

  const hasErrors = results.some((r) => r.status === "error");
  const hasCreated = results.some((r) => r.status === "created");
  const overallStatus = hasErrors && hasCreated ? "partial" : hasErrors ? "failed" : "completed";

  return {
    dealId: dealNumber,
    dealNumber,
    poResults: results,
    overallStatus,
  };
}
