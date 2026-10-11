# Operations → AP Warranty & Aviso alignment

## Status: readiness only, no external effects

**Default-off AP code/readiness checkpoint. Not a production cutover.** No Operations/VTiger/Make system was accessed or changed by this continuation. No external HTTP was performed, no source record or Xero document was read/created/amended, and no release policy, persistent flag, schedule, Heartbeat or publication was changed.

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
| Authentication | `x-financial-webhook-secret`, existing `FINANCIAL_AP_WEBHOOK_SECRET` |
| Event | Exact `warranty.aviso-requested` |
| Identity | One exact Deal webservice ID via `deal_id`, `record_id` or `id`; aliases, if multiple, must all agree |
| Release | Exact dedicated Warranty flag plus independently approved dedicated policy |
| Scope | New Events only; existing exact main Draft amendment plus one Aviso Draft PO |

Synthetic envelope (not a real record):

```json
{ "event": "warranty.aviso-requested", "deal_id": "5x77" }
```

A D-number, list of IDs, conflicting aliases or different event is rejected. Amount, customer, premium, item, tax, suffix and `Warranty Confirmed` from the webhook body cannot supply financial authority. The service re-reads exact current source/customer facts and Xero evidence; it never scans/browses a source ledger.

401 authentication precedes everything. An unset/nonliteral-true dedicated flag yields 503 before policy, body/service/source/Xero processing. An unavailable/invalid policy also yields 503 before processing. No generic family/global/Main/Storage release can enable the receiver.

## Actual source metadata and financial configuration: unproven and held

No fresh source describe/retrieve or Xero read was performed during this continuation. **There is no claim of verified production source config, item, price, account or tax values.** All test fixtures are explicitly synthetic.

| Required evidence | Current state |
| --- | --- |
| Actual Potentials ID prefix and exact Deal-number binding | Unproven for Warranty release |
| Added Services unique API name/label/full picklist/type/mandatory metadata | Unproven; no guessed custom API alias |
| Exactly one approved Added Services → native WAR item/description/GST-exclusive premium mapping | Unproven; `WAR-TEST` and premium 100 are tests only |
| Current linked organisation/contact and customer-name/Modified Time metadata | Unproven for this release |
| Source issue/due or preserve-main semantics; timestamp timezone and new-event delivery semantics | Unproven; ambiguous/local dates/times hold |
| Exact active Aviso Broking Pty Ltd ContactID and tenant | Unproven; required name is not contact verification |
| Actual native WAR sales/purchase descriptions, premiums, accounts and sold/purchased flags | Unproven |
| Active purchase account 313/INPUT and sales account/OUTPUT; actual active 10% tax rates | Unproven; code requirements are not live evidence |
| Full exact INV/I-reference history, original Draft lines/header/totals | Unproven; must be freshly revalidated for each separately authorized future event |

`Warranty Confirmed` is ignored. Unsupported Added Services, mapping/type/metadata drift, missing customer, invalid offset-bearing timestamps, unapproved hashes or source before approved cutover hold instead of guessing.

## Financial alignment and verified ordering

- Require exactly one unpaid/unallocated **AUD Exclusive ACCREC DRAFT** `INV-<Deal digits>` with complete existing line identities, accounts/tax/arithmetic, tracking/discounts, retained supported header fields and dates.
- Retain all existing full lines; append exactly one native approved WAR line. No remove/replace/adopt behavior and no whole-main creation when missing.
- Existing WAR line, non-Draft main, suffix history, unreadable/ambiguous main history or any exact Aviso `I<Deal digits>` PO collision holds. No approved alternative suffix path exists in this implementation.
- Create only the **AUD Exclusive DRAFT** Aviso `I<Deal digits>` PO with the exact native description/exclusive premium, account 313 and INPUT tax after verified main readback.
- **Main receipt must have `readbackVerified === true` at both writer authorization and DB attempt consumption.** HTTP success/ID/receipt existence or a truthy `"true"`/1 is not sufficient. Full-document line/header/date/contact/tax/totals comparison must pass; current main is compared again before PO.
- Every attempt is consumed before mocked transport; real transport is never automatically retried. Partial pair or uncertain readback keeps the immutable Deal claim and receipts and ends in `reconciliation_required`, not an invitation to replay.
- No CRM post-success update, legacy adoption/import, claim reset, browser release or retry control.

## Administrator preview semantics

The administrator page and all three tRPC procedures are queries, not mutation/release controls. Preview's `noWrites` contract prohibits financial/CRM document writes, but preview inserts a new local immutable AP evidence/hold entry and can later invoke identity authentication/token refresh plus source/accounting GETs. Thus it is **not** a zero-side-effect database query. In this continuation all source/accounting paths were mocked; no real preview was run. The applied but empty ledger can still fail closed if configuration/evidence is missing.

## Separately authorized prerequisites — no action performed

1. Test real uniqueness and ledger failure/concurrency handling safely before activation.
2. Prove actual exact source/customer metadata, one mapping/premium, date/time semantics and genuine post-cutover warranty-event delivery; approve corresponding hashes.
3. Prove exact live Aviso/item/accounts/tax/tenant evidence and safe non-production full-line Xero normalization/readback behavior.
4. Coordinate the warranty-only VTiger branch, Operations/Make legacy writer handover and Main Invoice warranty path; an AP GET/PUT cannot provide an external atomic lock.
5. Obtain explicit isolated Draft-main amendment/New Events-only/no-CRM-mutation approval with exact rules/configuration hashes. Do not treat this document or test fixtures as that approval.
6. Publication/activation or flag/policy changes remain separate explicitly authorized work. This checkpoint performs none of them.

Validation: mocked Warranty **8 files / 258 tests**; full requested suite excluding `server/microsoftGraphConfig.test.ts` **112 files / 1,158 tests**; TypeScript and build passed. See [AP handoff](warranty-aviso-handoff.md) for exact boundaries, warnings and limitations.
