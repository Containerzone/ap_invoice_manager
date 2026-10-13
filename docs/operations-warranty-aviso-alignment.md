# Operations → AP Warranty & Aviso alignment

## Status: first-ten New Events/Draft-only release active

On **13 October 2026**, the owner confirmed the Warranty & Aviso VTiger webhook uses the AP receiver with the canonical JSON `{ "id", "secret" }` body and that the Operations Warranty writer is switched off. The dedicated policy and runtime gate are now published and active for the first ten approved bands. The AP policy is **New Events only** and **Draft only**. It does not approve/send/pay/void/delete a Xero document or update VTiger after success.

The current AP code and policy support the first ten current Added Services bands only:

| Added Services | Xero item | GST-exclusive premium |
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

`Warranty $150k`, `$200k`, and `$250k` remain deliberately unsupported and hold without guessing an item, price or description.

## Dedicated AP receiver contract

| Surface | Contract |
| --- | --- |
| Private POST | `/api/webhooks/vtiger/warranty-aviso` |
| Authentication | Canonical VTiger JSON `secret` or existing header secret; no secret is logged or persisted |
| Identity | One exact `5x...` Deal ID, or one legacy D-number resolved by a bounded exact lookup after both dedicated gates |
| Body authority | `id` and authentication only; event, amount, customer, item, premium, tax, suffix and Warranty Confirmed are ignored |
| Gates | Dedicated runtime flag **and** immutable audited policy; neither inherits another family’s permission |
| Scope | New Events only; one exact existing main Draft amendment plus one Aviso Draft PO |

An unset/nonliteral-true flag or invalid policy holds before source/Xero processing. Lists, ambiguous D-numbers or conflicting aliases are rejected. No generic/global/Main/Storage release can enable this route.

## Verified current source and Xero evidence

A fresh, sequential GET-only audit verified:

- VTiger Potentials prefix `5`, `potential_no`, `related_to`, `contact_id`, `modifiedtime`, and `cf_potentials_extra` / **Added Services** as the exact multipicklist;
- account/contact name and modification-time metadata required for current customer re-resolution;
- the expected Xero tenant, one active Aviso contact, active account **200/OUTPUT** and **313/INPUT**, and active 10% INPUT/OUTPUT tax records;
- ten exact active purchased WAR items, each with the required purchase description and 313/INPUT purchase template.

The Operations split template is intentional:

1. **Customer main Draft:** preserve every existing line and append one line with the exact VTiger Added Services label, the mapped GST-exclusive premium, account **200**, and **OUTPUT** GST.
2. **Aviso PO:** use `ID<Deal>` as the PO number/reference, the exact Xero item **purchase description**, the same mapped GST-exclusive premium, account **313**, and **INPUT** GST.

The Xero item SalesDetails/default price are not a source of truth for either line. The policy contains a separate immutable configuration hash for every approved WAR item, so evidence for one band cannot authorize another.

## Immutable execution boundaries

- A full current source/customer/Xero preflight runs before any claim; contact creation uses the separately active safe customer-contact resolver only on a missing-contact hold, then repeats full preflight.
- Exactly one unpaid/unallocated AUD Exclusive ACCREC **DRAFT** `INV-<Deal digits>` must exist. Existing WAR line, non-Draft main, suffix/collision history, unreadable evidence or an existing `ID<Deal>` PO holds.
- The main line is POSTed only once, then read back exactly. The PO can proceed only after `readbackVerified === true` for the main Draft and a second fresh comparison.
- Transport is never automatically retried. Any partial/uncertain result remains in `reconciliation_required`; claims are never cleared or adopted from legacy history.
- No CRM post-success update, schedule or browser release/retry control exists.

## Activation verification

The implementation/policy checkpoint was published, `FINANCIAL_WARRANTY_AUTOMATIC_ENABLED=true` was deployed, and an authenticated public nonexistent-ID probe returned parser-safe **400**. It created no Warranty event and no Xero write. Only a new post-cutover qualifying event may proceed; its own fresh source/Xero preflight controls the Draft-only pair.

Migration `0045_slow_archangel.sql` is applied and the Warranty event ledger remains empty. No Xero document, contact, item or VTiger record was changed while validating or preparing this release.
