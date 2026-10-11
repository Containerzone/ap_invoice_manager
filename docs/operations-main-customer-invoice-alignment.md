# Operations-to-AP Main Customer Invoice Alignment

**Sources:** User-authorised Operations history task `z4BCTK6qpMx1xSv13ILqTy`, including `ContainerZone_PO_and_Customer_Invoice_Trigger_Report.md` (25 September 2026); AP's authenticated VTiger metadata reads on 11 October 2026. Metadata reads were GET-only after VTiger form login and made no record, workflow or financial change.

## Operations behavior to preserve

| Rule | Authorised Operations behavior | AP implementation target |
|---|---|---|
| Trigger | Dedicated VTiger main-invoice workflow calls the CRM endpoint; the endpoint does not hard-code a stage. | Dedicated protected AP endpoint, default off. |
| Source | Current Deal, linked Quote and Quote billable service lines. | Re-read all sources before proposal/write; webhook body is ID-only. |
| Number | `INV-<Deal digits>`. | Example: `D702877` → `INV-702877`. |
| Document | One Xero customer invoice, initially `ACCREC` + `DRAFT`. | Create-only Draft POST; never authorise, send, pay, void, delete or replace. |
| Customer priority | Organisation before contact. | Exact current Account is preferred; fallback exact Contact only when no organisation exists. |
| Quote lines | Service name, quantity and list price. | Preserve each billable Quote line, its native service/item code, account and description; do not synthesize prices from the webhook. |
| Collision/idempotency | Do not create `INV-…` where it already exists. | Exact Xero number collision is held (including non-Draft/deleted/voided history) and never adopted or suffix-bypassed. |
| Warranty | A supported Added Services warranty may be appended by the main-invoice/warranty workflow and may create a matching Aviso PO. | Excluded from the first Main Invoice release: main invoice itself only; warranty remains its independently gated family. |

## Verified VTiger source mapping

| Entity | Field | Label | Purpose |
|---|---|---|---|
| `Potentials` (Deal) | `potential_no` | Potential No | Deal business number / `D…` reference |
| `Potentials` | `related_to` | Organization Name | Preferred customer Account reference |
| `Potentials` | `contact_id` | Contact Name | Fallback customer Contact reference |
| `Potentials` | `cf_potentials_quotereference` | Quote Reference | Linked Quote reference |
| `Potentials` | `items_sync_with` | Quote | Alternate linked Quote reference |
| `Quotes` | `quote_no` | Quote ID | Invoice reference when present |
| `Quotes` | `account_id` | Organization Name | Quote customer Account reference |
| `Quotes` | `contact_id` | Contact Name | Quote customer Contact reference |
| `Quotes` | `hdnSubTotal`, `hdnGrandTotal` | Sub Total, Total | Cross-check only; not a substitute for billable lines |
| `Quotes` | `xero_account` | Xero Sales Account | Quote sales account context |

## Release boundary

The Operations report is authoritative that a main invoice requires a linked Quote with billable service lines. The published metadata proves Deal/Quote linkage and customer reference fields, but does **not** itself reveal the specific Quote line-item child-record query contract. Until the exact VTiger Quote service-line source is verified through a bounded read/metadata check, AP must return a factual hold—not infer a main-invoice amount from Quote totals.
