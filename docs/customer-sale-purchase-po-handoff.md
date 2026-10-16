# Customer Sale Purchase PO — AP Migration Handover

**Status:** **Live for new Customer Sale / Request events only** from 14 October 2026, 17:03:47 Australia/Sydney. The runtime gate, published receiver and current AP-local policy are active.
**Operations alignment:** [Operations Customer Sale alignment](operations-customer-sale-alignment.md)  
**Scope:** One Xero **Draft Purchase Order** for a new, exact VTiger Container Control Customer Sale event. No invoice, approval, sending, payment, voiding, deletion, or historical adoption.

## Implemented AP components

| Component | AP implementation |
|---|---|
| Protected receiver | `POST /api/webhooks/vtiger/container-control-customer-sale` |
| Authentication | Existing `x-financial-webhook-secret` private header; body must name exact `id` or `record_id` in VTiger `moduleId` form such as `24x901` |
| Current-source authority | Webhook body financial values are ignored. AP re-reads the exact Container Control and assigned VTiger Vendor. |
| Source eligibility | Acquisition exactly `CUSTOMER SALE`; status exactly `REQUEST`; assigned supplier, container ID, Purchase Price INCL GST and Purchase Date all required. |
| Order number / Xero reference | Order number `S<Container Control>` — e.g. `C1895` → `SC1895`; the separate Xero **Reference** field is intentionally blank |
| PO line | `20' Sale` or `40' Sale` selected from current container type, account `322`, AUD, GST exclusive, price = VTiger `Purchase Price INCL GST / 1.10`; description resolves the native container-type and condition placeholders. |
| Xero evidence | GET-only exact contact, item and duplicate-reference preflight. Any existing `S…` reference is held—not adopted, suffixed or overwritten. |
| Write boundary | New Xero Purchase Order `POST` only; exactly one line, `DRAFT`, `AUD`, `Exclusive`, account `322`; exact Xero Draft read-back required before local success. |
| Idempotency | AP-only `financial_customer_sale_purchase_po_events` ledger: unique Container Control and unique PO reference, exclusive claim and exact payload hash. |
| UI | Administrator sidebar → **Customer Sale POs**: current source/Xero preview, non-secret readiness and lifecycle receipts. No browser write button. |

## Activation record

- `FINANCIAL_CUSTOMER_SALE_PURCHASE_AUTOMATIC_ENABLED=true` is configured for this family only.
- The independent policy `CUSTOMER-SALE-PO-315e9577f00f5921` is enabled with `new_events_only` scope, the approved current Sale-item and blank-reference rules hash, dedicated Customer Sale branch assertion and Operations Customer Sale handover assertion.
- No Customer Sale Heartbeat exists (none is required).
- The pre-cutover C1879 event remains held because its current source status is not `REQUEST`; it is not eligible for replay under the new-events-only release.
- An authenticated local public-receiver probe using a deliberately nonexistent Container Control returned `202` held and `xeroWritesAttempted: 0`; no Xero or VTiger record was created or changed.
- The reference-free PO rule is published. An authenticated public probe using a deliberately nonexistent Container Control returned `202` held with `xeroWritesAttempted: 0`, proving the public receiver loaded the current release gate without creating a source, Xero or VTiger write.
- **C1915 one-time recovery:** The pre-cutover Customer Sale record was individually preflighted and owner-approved. AP verified the current `CUSTOMER SALE / REQUEST` source, exact supplier contact, selected `20' Sale` item and absence of an existing `SC1915` PO, then created and re-read Xero Draft PO `SC1915` (execution `840001`, Xero PO ID `8c0e3770-b01f-4fec-b083-a8c7a3341ddb`). Its Xero Reference is blank. No VTiger change, PO approval, sending, payment, void, deletion or update occurred; the related operational hold was resolved.

## Published-receiver verification

Do **not** treat public automation as live until the latest activation checkpoint has been deployed and all of these have been confirmed:

1. Verify the public endpoint returns authenticated JSON and does not return `customer-sale-purchase-release-disabled`.
2. Confirm the dedicated VTiger action is only for `Acquisition = CUSTOMER SALE` and `Status = REQUEST`, posting the existing authenticated body to:
   ```text
   https://apinvmanager-dm3caxom.manus.space/api/webhooks/vtiger/container-control-customer-sale
   ```
3. Retain the confirmed Operations **Customer Sale** writer pause for future events only. Do not change Asset or For Hire branches.
4. Send one qualifying post-cutover event and inspect **Customer Sale POs**. Verify the exact `S…` number, supplier contact, selected `20' Sale`/`40' Sale` item, account `322`, GST-exclusive amount, date, placeholder-resolved line description and Xero `DRAFT` read-back.

A failed preflight, a changed source, an existing Xero reference or an uncertain Xero response must remain held for reconciliation. It must not retry as a new document or adjust an existing record.
