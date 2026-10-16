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
| Quote lines | Service name, quantity and list price. | Preserve each billable Quote quantity and list price; do not synthesize prices from the webhook. Only an explicitly transport-named Service receives the approved transport item and native route description. A 20/40-foot container product receives the matching current Sale item and retains its exact Quote Service name. A container-hire Service and every other non-transport Service retain their exact current Quote name without a guessed Xero item. |
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
| `Potentials` | `cf_potentials_containersituationselectone` | Container Situation (Select One) | Exact transport-item classification: `SHIPPER OWN` → SER9; `PURCHASED`/`HIRED` → SER60; all other values hold |
| `Potentials` | `cf_potentials_pickuplocation` | Origin Suburb | Replaces only the first `<>` of the current Xero native transport template |
| `Potentials` | `cf_potentials_deliverylocation` | Destination Suburb | Replaces only the second `<>` of the current Xero native transport template |
| `Quotes` | `quote_no` | Quote ID | Invoice reference when present |
| `Quotes` | `account_id` | Organization Name | Quote customer Account reference |
| `Quotes` | `contact_id` | Contact Name | Quote customer Contact reference |
| `Quotes` | `hdnSubTotal`, `hdnGrandTotal` | Sub Total, Total | Cross-check only; not a substitute for billable lines |
| `Quotes` | `xero_account` | Xero Sales Account | Quote sales account context |

## Approved Main Invoice transport presentation

The current Xero items were independently read with GET-only evidence before implementation:

| Current Deal Container Situation | Required Xero sales item | Native Xero description retained by AP |
|---|---|---|
| `SHIPPER OWN` | `SER9` | `Loaded Container from <> to <>` |
| `PURCHASED` or `HIRED` | `SER60` | `Empty & Loaded Container from <> to <>` |
| `IMPORT`, blank or any unrecognised value | none | **Hold** — AP never guesses or treats it as Purchased/Hired. |

Both verified transport items are active for sale with account 200 and OUTPUT GST. Immediately before write AP must replace only the two placeholders **on explicit transport lines** using the freshly re-read Deal suburbs, then perform a new full invoice collision/contact/item preflight. This changes transport presentation/item classification only; the current Quote quantity and list-price calculation remains the financial source. A container-product Quote line is never overwritten with this route description.

## Release boundary

The Operations report is authoritative that a main invoice requires a linked Quote with billable service lines. The published metadata proves Deal/Quote linkage and customer reference fields, but does **not** itself reveal the specific Quote line-item child-record query contract. Until the exact VTiger Quote service-line source is verified through a bounded read/metadata check, AP must return a factual hold—not infer a main-invoice amount from Quote totals.
