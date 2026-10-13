# Operations reference — Warranty & Aviso alignment

> **Scope.** This records authorised Operations-agent artifacts and fresh VTiger/Xero GET-only evidence collected on **2026-10-13**. It does not record a financial document write.

## Current VTiger source

- Potentials Added Services: `cf_potentials_extra`, label **Added Services**, type **multipicklist**.
- Deal/customer source: `potential_no`, `related_to`, `contact_id`, `modifiedtime`; current Accounts/Contacts metadata provides names and `modifiedtime`.
- `cf_potentials_pdssent` / Warranty Confirmed is a boolean and is **not** a trigger or fallback.
- Zero or more than one selected supported Warranty value holds. No free-text or checkbox inference is permitted.

## Approved first-ten mapping

| Added Services | Xero item code | GST-exclusive premium |
| --- | --- | ---: |
| Warranty $25k | WAR25 | $192.50 |
| Warranty $30k | WAR30 | $228.90 |
| Warranty $40k | WAR40 | $305.20 |
| Warranty $50k | WAR50 | $381.50 |
| Warranty $60k | WAR60 | $457.80 |
| Warranty $70k | WAR70 | $534.10 |
| Warranty $75k | WAR75 | $572.25 |
| Warranty $80k | WAR80 | $610.40 |
| Warranty $90k | WAR90 | $686.70 |
| Warranty $100k | WAR100 | $763.00 |

`Warranty $150k`, `$200k` and `$250k` are live VTiger values but remain unsupported. They must hold until each is separately mapped and approved.

## Exact Operations template

| Document | Description | Amount authority | Account / tax |
| --- | --- | --- | --- |
| Existing customer main Draft append | Exact VTiger Added Services label | Approved mapping premium | `200` / `OUTPUT` |
| Aviso Draft PO | Exact Xero item **PurchaseDescription** | Same approved mapping premium | `313` / `INPUT` |

The PO reference is `ID<Deal>` (for example, a D-number becomes `ID...`). The item SalesDetails/default price are deliberately not financial authority for this workflow.

## Fresh release evidence

The sequential live read verified the expected tenant, one active Aviso contact, account `200`/OUTPUT, account `313`/INPUT, active 10% INPUT/OUTPUT taxes, and all ten exact active purchased WAR items with non-empty purchase descriptions and the required 313/INPUT purchase template.

The release policy binds each of the ten items to its own configuration hash. A later drift in the tenant, Aviso contact, selected item, account, tax or native purchase description holds the event before reservation/write.

## Legacy boundaries retained

- The canonical VTiger JSON `id` / `secret` envelope is accepted; the body never supplies financial authority.
- Old Operations suffix/retry/reconciliation behaviour is not imported. AP uses one-shot, exact Draft-only operations and immutable receipts.
- Historical source artifacts contain personal/legacy document data and are intentionally not copied into this repository.
