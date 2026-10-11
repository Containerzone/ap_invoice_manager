# Operations-to-AP Customer Sale PO Alignment

**Source:** User-authorised Operations history task `z4BCTK6qpMx1xSv13ILqTy`, including `ContainerZone_PO_and_Customer_Invoice_Trigger_Report.md` (25 September 2026), its `vtigerCcWebhook` regression evidence, and its Customer Sale dry-run payload.

## Verified Operations behavior to preserve

| Rule | Operations evidence | AP implementation target |
|---|---|---|
| Source module | VTiger Container Control | `vtcmcontainercontrols` exact-current read only |
| Trigger point | The dedicated VTiger rule dispatches at `REQUEST` | Current source must have `Status = REQUEST` |
| Acquisition | `CUSTOMER SALE` | Exact normalized acquisition value only |
| Xero reference | `S<Container Control number>` | Example: control `C1895` → `SC1895` |
| Xero document | One Draft supplier Purchase Order | New Draft POST only; never authorise, send, pay, void, delete or adopt existing PO |
| Account | `322` | Exact line account `322` |
| Cost source | `Purchase Price INCL GST` on the Container Control | Positive amount required; divide by 1.10, enter Xero as GST-exclusive AUD |
| Supplier | Exact referenced VTiger Supplier Name/Vendor | AP re-reads the linked Vendor; webhook names/prices are ignored |
| Description | Container ID, record ID, Customer Sale, type, grade, collection depot and purchase date | Rich-text VTiger Notes excluded |
| Idempotency | One PO per Container Control; Operations held duplicates | AP has its own exclusive ledger reservation and holds any existing exact Xero `S…` reference |

## Dry-run evidence

The Operations dry-run had: Container Control `79x482535`, business number `C1895`, acquisition `CUSTOMER SALE`, Vendor `VS&B Containers`, purchase price `5573.13` inclusive, purchase date `2026-09-15`, type `20 Foot Standard`, grade `Brand New`, collection depot `MELBOURNE, VIC.3000`, container ID `D702877`.

Expected operational description:

> `D702877 (79x482535) — Customer Sale — 20 Foot Standard — Brand New — MELBOURNE, VIC.3000 — Purchase Date: 2026-09-15`

The report describes the shared historical Operations Container Control endpoint as `/api/webhooks/vtiger-cc-created`; only a later dedicated AP branch may post to the AP Customer Sale receiver. The branch must exclude Asset and For Hire records, and the Operations Customer Sale writer must be paused before any AP write gate is enabled.

## Scope boundary

This alignment record documents source behavior only. It does not activate an AP Customer Sale webhook, deployment gate, release policy, Heartbeat, or Xero document.
