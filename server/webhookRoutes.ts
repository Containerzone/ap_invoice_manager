/**
 * Vtiger Webhook Endpoint
 *
 * Receives POST requests from Vtiger when a Deal reaches Stage 1.
 * Phase 1: logs the raw payload to the database so we can discover
 *           the exact field names before building the PO creation logic.
 * Phase 2: processes the payload to create Xero Draft POs.
 */
import { Router, Request, Response } from "express";
import { getDb } from "./db";
import { poRequests } from "../drizzle/schema";

const router = Router();

/**
 * POST /api/vtiger-webhook
 *
 * Vtiger sends a POST with either:
 *   - application/json body, or
 *   - application/x-www-form-urlencoded body (Vtiger default)
 *
 * We accept both and store the raw payload for inspection.
 */
router.post("/api/vtiger-webhook", async (req: Request, res: Response) => {
  try {
    const body = req.body ?? {};
    const contentType = req.headers["content-type"] ?? "";

    console.log("[Vtiger Webhook] Received payload, content-type:", contentType);
    console.log("[Vtiger Webhook] Raw body:", JSON.stringify(body, null, 2));

    // Extract Deal ID from common Vtiger webhook field names
    // Vtiger typically sends: id, record_id, crmid, or data.id
    const dealId =
      body.id ??
      body.record_id ??
      body.crmid ??
      body.data?.id ??
      body.data?.crmid ??
      `unknown-${Date.now()}`;

    const dealNumber =
      body.deal_no ??
      body.opportunity_no ??
      body.potentialname ??
      body.data?.deal_no ??
      body.data?.opportunity_no ??
      null;

    const dealName =
      body.potentialname ??
      body.deal_name ??
      body.name ??
      body.data?.potentialname ??
      body.data?.deal_name ??
      null;

    // Store the raw payload — we will inspect this to discover field names
    const db = await getDb();
    if (!db) throw new Error("Database not available");
    await db.insert(poRequests).values({
      vtigerDealId: String(dealId),
      vtigerDealNumber: dealNumber ? String(dealNumber) : null,
      vtigerDealName: dealName ? String(dealName) : null,
      vtigerQuoteId: null,
      vtigerQuoteNumber: null,
      status: "pending",
      rawPayload: body,
      poResults: null,
      errorMessage: null,
    });

    console.log(`[Vtiger Webhook] Stored payload for deal: ${dealId} (${dealName ?? "unnamed"})`);

    // Respond 200 immediately so Vtiger does not retry
    res.status(200).json({ success: true, message: "Webhook received" });
  } catch (err: any) {
    console.error("[Vtiger Webhook] Error storing payload:", err.message);
    // Still return 200 to prevent Vtiger from retrying indefinitely
    res.status(200).json({ success: false, message: "Webhook received but storage failed" });
  }
});

/**
 * GET /api/vtiger-webhook/test
 * Simple health-check so you can verify the endpoint is reachable.
 */
router.get("/api/vtiger-webhook/test", (_req: Request, res: Response) => {
  res.json({ success: true, message: "Vtiger webhook endpoint is live", timestamp: new Date().toISOString() });
});

export function registerVtigerWebhook(app: import("express").Application) {
  app.use(router);
}
