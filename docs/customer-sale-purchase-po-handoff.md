# Customer Sale Purchase PO — AP Migration Handover

**Status:** Implemented and tested in AP Management; **not live**.  
**Operations alignment:** [Operations Customer Sale alignment](operations-customer-sale-alignment.md)  
**Scope:** One Xero **Draft Purchase Order** for a new, exact VTiger Container Control Customer Sale event. No invoice, approval, sending, payment, voiding, deletion, or historical adoption.

## Implemented AP components

| Component | AP implementation |
|---|---|
| Protected receiver | `POST /api/webhooks/vtiger/container-control-customer-sale` |
| Authentication | Existing `x-financial-webhook-secret` private header; body must name exact `id` or `record_id` in VTiger `moduleId` form such as `24x901` |
| Current-source authority | Webhook body financial values are ignored. AP re-reads the exact Container Control and assigned VTiger Vendor. |
| Source eligibility | Acquisition exactly `CUSTOMER SALE`; status exactly `REQUEST`; assigned supplier, container ID, Purchase Price INCL GST and Purchase Date all required. |
| PO reference | `S<Container Control>` — e.g. `C1895` → `SC1895` |
| PO line | `20' Sale` or `40' Sale` selected from current container type, account `322`, AUD, GST exclusive, price = VTiger `Purchase Price INCL GST / 1.10`; description resolves the native container-type and condition placeholders. |
| Xero evidence | GET-only exact contact, item and duplicate-reference preflight. Any existing `S…` reference is held—not adopted, suffixed or overwritten. |
| Write boundary | New Xero Purchase Order `POST` only; exactly one line, `DRAFT`, `AUD`, `Exclusive`, account `322`; exact Xero Draft read-back required before local success. |
| Idempotency | AP-only `financial_customer_sale_purchase_po_events` ledger: unique Container Control and unique PO reference, exclusive claim and exact payload hash. |
| UI | Administrator sidebar → **Customer Sale POs**: current source/Xero preview, non-secret readiness and lifecycle receipts. No browser write button. |

## Current lock state

- `FINANCIAL_CUSTOMER_SALE_PURCHASE_AUTOMATIC_ENABLED` is **not true**.
- No Customer Sale release policy is recorded.
- No Customer Sale Heartbeat exists (none is required).
- AP Customer Sale event rows: **0**; read-back verified Xero Customer Sale Draft POs: **0**.
- Unauthenticated local receiver response: `401` JSON. This confirms the receiver is mounted but does not reveal or exercise the secret.

## Separate live-cutover prerequisites

Do **not** treat the implementation as live until all of these are explicitly confirmed in the then-current conversation:

1. Publish the checkpoint containing this receiver and UI; verify the public endpoint returns authenticated JSON rather than application HTML.
2. In VTiger, create/enable a dedicated AP action only for `Acquisition = CUSTOMER SALE` and `Status = REQUEST`, posting the existing authenticated body to:
   ```text
   https://apinvmanager-dm3caxom.manus.space/api/webhooks/vtiger/container-control-customer-sale
   ```
3. Pause the Operations **Customer Sale** writer for future events only. Do not change Asset or For Hire branches.
4. Confirm the exact effective Sydney timestamp and `new_events_only` scope.
5. Explicitly approve automatic **Draft-only** Customer Sale POs. AP must then record its own release policy and enable only `FINANCIAL_CUSTOMER_SALE_PURCHASE_AUTOMATIC_ENABLED=true`.
6. Send one qualifying new event and inspect **Customer Sale POs**. Verify the exact `S…` number, supplier contact, selected `20' Sale`/`40' Sale` item, account `322`, GST-exclusive amount, date, placeholder-resolved line description and Xero `DRAFT` read-back.

A failed preflight, a changed source, an existing Xero reference or an uncertain Xero response must remain held for reconciliation. It must not retry as a new document or adjust an existing record.
