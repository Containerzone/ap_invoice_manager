# Operations → AP Warranty & Aviso alignment

## Status: implementation integrated; release held on source/Xero evidence

**Warranty remains independently default-off and is not a production cutover.** The shared customer-contact gates are active for separately authorised customer-invoice families, but do not enable Warranty. No Warranty release policy/flag, Operations/VTiger/Make setting, schedule, Heartbeat or financial document was changed by this implementation.

On 13 October 2026, the owner confirmed the Warranty & Aviso VTiger webhook is published to the AP route with the canonical `id` / `secret` JSON body and the Operations writer is switched off. The AP family remains held: after the Xero quota recovered, a bounded read-only configuration audit found unsafe WAR sales configuration. The dedicated Warranty runtime gate remains false and no release policy has been enabled.

**Migration 0045 was generated, inspected and applied through the managed AP SQL tool.** `drizzle/0045_slow_archangel.sql` adds only the AP immutable warranty event table. A read-only query confirmed the newly applied ledger has 0 events and 0 execution-or-receipt rows. This local schema change did not access or modify Operations, VTiger, Make or Xero.

## Legacy inventory is not handover evidence

The scaffolding's `getWarrantyReadiness` inventories the legacy Warranty reconcile endpoint as `https://supplycrm-7kuu33x8.manus.space/api/webhooks/vtiger-warranty-reconcile` and a separate **Main Customer Invoice warranty entry path**. This inventory was read from code only: the URL was not fetched and the deployed behavior was not inspected. It does not prove either writer is paused, handed over or coordinated.

Any future cutover needs both:

- Warranty-only VTiger branch and Operations/Make warranty writer handover acknowledgment.
- Main Invoice warranty-entry coordination acknowledgment so another writer cannot add a WAR line or replace the same main invoice concurrently.

No acknowledgment or operational approval was recorded here.

## Dedicated AP receiver contract

| Surface | Contract |
| --- | --- |
| Private POST | `/api/webhooks/vtiger/warranty-aviso` |
| Authentication | Canonical VTiger JSON `secret` or existing header secret; no secret is logged or persisted |
| Event | Not authoritative; ignored |
| Identity | One exact Deal webservice ID via `deal_id`, `record_id` or `id`, or a legacy D-number resolved by one bounded exact lookup after the two family gates; aliases, if multiple, must all agree |
| Release | Exact dedicated Warranty flag plus independently approved dedicated policy |
| Scope | New Events only; existing exact main Draft amendment plus one Aviso Draft PO |

Synthetic envelope (not a real record):

```json
{ "id": "5x77", "secret": "[canonical shared secret]" }
```

A list of IDs, an ambiguous D-number or conflicting aliases is rejected. Amount, customer, premium, item, tax, suffix and `Warranty Confirmed` from the webhook body cannot supply financial authority. The service re-reads exact current source/customer facts and Xero evidence; it never scans/browses a source ledger.

401 authentication precedes everything. An unset/nonliteral-true dedicated flag yields 503 before policy, body/service/source/Xero processing. An unavailable/invalid policy also yields 503 before processing. No generic family/global/Main/Storage release can enable the receiver.

## Actual source metadata and financial configuration: verified conflict, held

The current VTiger Potentials metadata was read safely on 13 October. `cf_potentials_extra` / **Added Services** is an exact multipicklist and `cf_potentials_pdssent` / Warranty Confirmed is a boolean. The active field values are `$25k, $30k, $40k, $50k, $60k, $70k, $75k, $80k, $90k, $100k, $150k, $200k, $250k`.

This conflicts with the supplied required map of exactly `$10k, $15k, $25k, $35k, $50k, $75k, $100k, $150k, $200k, $300k`. The current code uses the owner-approved Operations pairs for the first ten live bands and holds on $150k/$200k/$250k. A fresh bounded Xero audit proved the expected tenant, active Aviso contact, account 313/INPUT and active 10% INPUT/OUTPUT taxes. However, all WAR25–WAR100 items currently have `SalesDetails` account 313 and INPUT tax, sale/purchase descriptions do not match, and WAR25's purchase price is $195.50 rather than $192.50. **The live WAR items must not be used for a customer main invoice until their SalesDetails are configured to an active revenue account with OUTPUT GST and the exact native descriptions/prices are aligned.**

| Required evidence | Current state |
| --- | --- |
| Actual Potentials ID prefix and exact Deal-number binding | Verified source prefix `5` and standard `potential_no`; release still needs post-cutover event evidence |
| Added Services unique API name/label/full picklist/type/mandatory metadata | Verified `cf_potentials_extra` / Added Services / multipicklist; values conflict with supplied required mapping |
| Exactly one approved Added Services → native WAR item/description/GST-exclusive premium mapping | First ten live-band code/premium pairs approved; blocked on matching native descriptions, SalesDetails revenue/OUTPUT setup, WAR25 purchase-price correction and $150k/$200k/$250k mapping |
| Current linked organisation/contact and customer-name/Modified Time metadata | Source fields verified; every event is re-read and must pass the shared customer-contact resolver |
| Source issue/due or preserve-main semantics; timestamp timezone and new-event delivery semantics | Unproven; ambiguous/local dates/times hold |
| Exact active Aviso Broking Pty Ltd ContactID and tenant | Verified through bounded current GET-only audit |
| Actual native WAR sales/purchase descriptions, premiums, accounts and sold/purchased flags | Sold/purchased flags verified; descriptions differ; SalesDetails use unsafe account 313/INPUT; WAR25 purchase premium differs |
| Active purchase account 313/INPUT and sales account/OUTPUT; actual active 10% tax rates | Account 313/INPUT and INPUT/OUTPUT tax rates verified; sales revenue/OUTPUT account is not configured/proven |
| Full exact INV/I-reference history, original Draft lines/header/totals | Unproven; must be freshly revalidated for each separately authorized future event |

`Warranty Confirmed` is ignored. Unsupported Added Services, mapping/type/metadata drift, missing customer, invalid offset-bearing timestamps, unapproved hashes or source before approved cutover hold instead of guessing.

## Financial alignment and verified ordering

- Require exactly one unpaid/unallocated **AUD Exclusive ACCREC DRAFT** `INV-<Deal digits>` with complete existing line identities, accounts/tax/arithmetic, tracking/discounts, retained supported header fields and dates.
- Retain all existing full lines; append exactly one native approved WAR line. No remove/replace/adopt behavior and no whole-main creation when missing.
- Existing WAR line, non-Draft main, suffix history, unreadable/ambiguous main history or any exact Aviso `ID<Deal digits>` PO collision holds. No approved alternative suffix path exists in this implementation.
- Create only the **AUD Exclusive DRAFT** Aviso `ID<Deal digits>` PO with the exact native description/exclusive premium, account 313 and INPUT tax after verified main readback.
- **Main receipt must have `readbackVerified === true` at both writer authorization and DB attempt consumption.** HTTP success/ID/receipt existence or a truthy `"true"`/1 is not sufficient. Full-document line/header/date/contact/tax/totals comparison must pass; current main is compared again before PO.
- Every attempt is consumed before mocked transport; real transport is never automatically retried. Partial pair or uncertain readback keeps the immutable Deal claim and receipts and ends in `reconciliation_required`, not an invitation to replay.
- No CRM post-success update, legacy adoption/import, claim reset, browser release or retry control.

## Administrator preview semantics

The administrator page and all three tRPC procedures are queries, not mutation/release controls. Preview's `noWrites` contract prohibits financial/CRM document writes, but preview inserts a new local immutable AP evidence/hold entry and can later invoke identity authentication/token refresh plus source/accounting GETs. Thus it is **not** a zero-side-effect database query. In this continuation all source/accounting paths were mocked; no real preview was run. The applied but empty ledger can still fail closed if configuration/evidence is missing.

## Separately authorized prerequisites — no action performed

1. Test real uniqueness and ledger failure/concurrency handling safely before activation.
2. Prove actual exact source/customer metadata, one mapping/premium, date/time semantics and genuine post-cutover warranty-event delivery; approve corresponding hashes.
3. Prove exact live Aviso/item/accounts/tax/tenant evidence and safe non-production full-line Xero normalization/readback behavior.
4. Coordinate the warranty-only VTiger branch, Operations/Make legacy writer handover and Main Invoice warranty path; an AP GET/POST amendment cannot provide an external atomic lock.
5. Obtain explicit isolated Draft-main amendment/New Events-only/no-CRM-mutation approval with exact rules/configuration hashes. Do not treat this document or test fixtures as that approval.
6. Publication/activation or flag/policy changes remain separate explicitly authorized work. This checkpoint performs none of them.

Validation: mocked Warranty **8 files / 258 tests**; full requested suite excluding `server/microsoftGraphConfig.test.ts` **112 files / 1,158 tests**; TypeScript and build passed. See [AP handoff](warranty-aviso-handoff.md) for exact boundaries, warnings and limitations.
