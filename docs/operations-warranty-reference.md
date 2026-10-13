# Operations reference — Warranty & Aviso alignment

> **Source and scope.** This records the authorised Operations-agent reference task `z4BCTK6qpMx1xSv13ILqTy` and a fresh VTiger metadata read on **2026-10-13**. It is implementation evidence only; it does not approve a Xero write, policy, VTiger change, or activation.

## Confirmed current VTiger source

- The exact Potentials field is `cf_potentials_extra`, label **Added Services**, type **multipicklist**.
- `cf_potentials_pdssent` / **Warranty Confirmed** is a boolean and is **not** a warranty trigger or fallback.
- Deal identity and customer links use the metadata-backed standard fields already used by AP: `potential_no`, `related_to`, `contact_id`, and `modifiedtime`; current Accounts/Contacts metadata supplies their names and `modifiedtime`.
- Any current value with zero or more than one selected supported warranty must hold. The platform must not infer a warranty from free text or the boolean checkbox.

## Operations warranty mappings

| Added Services value | Xero item code | GST-exclusive premium |
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

`Warranty $150k`, `Warranty $200k`, and `Warranty $250k` are present in the live picklist but remain deliberately unsupported: no item/premium may be guessed.

## Release-blocking mapping conflict

The current owner-supplied required template specifies a different, exact ten-band map: `Warranty $10k`, `$15k`, `$25k`, `$35k`, `$50k`, `$75k`, `$100k`, `$150k`, `$200k`, and `$300k`, with item codes `WAR10K` through `WAR300K` and the supplied GST-exclusive premiums/native descriptions. Those values do **not** match the current live VTiger field or this historical Operations mapping.

The owner has approved the historical item-code and GST-exclusive-premium pairs for the first ten current bands (`$25k` through `$100k` above). The native description remains deliberately dynamic: it is read from the exact current Xero item and must match both its sale and purchase description before a release policy can approve it; no description is hard-coded or guessed.

`Warranty $150k`, `$200k` and `$250k` remain unsupported and each such event must hold. They do not prevent a future separately approved **first-ten-only** release; a higher-band mapping must be separately approved before that specific band can ever proceed.

The initial bounded Xero GET-only configuration audit was rate-limited. After the Accounting quota recovered, a replacement bounded audit proved the expected tenant, one active Aviso contact, active account 313/INPUT and active 10% INPUT/OUTPUT tax records. It also found that all first-ten WAR items currently expose account 313/INPUT in SalesDetails, their sale/purchase descriptions differ, and WAR25 has a $195.50 purchase price. A second audit after the owner reported the corrections found the same values, so no corrected item configuration is yet visible in this Xero tenant. The three higher bands remain unsupported; no premium, item code or description will be inferred.

## Operations template and lifecycle facts to preserve

- Customer main draft: retain the exact current Draft and append **one** native WAR line only when it has no existing WAR line.
- Aviso supplier is **Aviso Broking Pty Ltd**; purchase account `313`; the purchase line uses the same native item description and the mapped GST-exclusive premium.
- The legacy artefact’s PO reference formatter is `I${dealNumber}` (therefore `ID702...` when the Deal number includes its `D` prefix). AP must confirm the exact current Xero reference convention before enabling a writer; it must not silently adopt the earlier AP readiness placeholder `I<digits>`.
- The legacy receiver accepted the established JSON `id` / `secret` envelope. AP’s compatibility receiver must continue to authenticate the canonical body secret without logging it, then re-read all financial facts from VTiger.
- Older Operations behavior included Draft reconciliation and suffix paths. These are **not** adopted automatically by AP: Draft-only append/create remains one-shot, collision-safe and no-retry unless a separately implemented, approved reconciliation path exists.

## Evidence reviewed

- `conditional-warranty-main-invoice-workflow.md`
- `warrantyPurchaseOrders.ts`
- `inspect_vtiger_added_services.mts`
- `dry_run_d702116_warranty_description.mts`
- `dry_run_d702870_warranty_po.mts`
- `inspect_d702116_warranty_invoice.mts`
- `august_2026_warranty_evidence.json`

The historical evidence file contains personal and legacy document data and is intentionally not copied into this repository. A live Xero configuration audit began but stopped on the current tenant daily allowance 429 response; no Xero document write was attempted.
