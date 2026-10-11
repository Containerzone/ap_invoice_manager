# Operations → AP Final Weight alignment

## Status and authority

**AP-only readiness implementation; default off. Not a production cutover.** This records the authorised reference history supplied for this task and a metadata-only Potentials verification on 2026-10-11. No Operations code, VTiger action, Make setting, schedule, Heartbeat, release policy or financial environment flag was changed. No real Xero document or VTiger record was created/amended.

The reference history establishes **two independently configured Operations branches**. The legacy writer inventory names `vtiger-finalise-main-invoice` (overweight) and `vtiger-finalise-main-invoice-underweight` (underweight). Those are alignment facts, not evidence that either legacy writer has been handed over. This task did not browse Operations or source records.

| Branch | Dedicated AP POST receiver | Permitted change |
| --- | --- | --- |
| Overweight | `/api/webhooks/vtiger/final-weight-overweight` | Amend the exact current Draft `INV-<Deal digits>` with exactly one positive GST-exclusive `SER70` excess-weight line |
| Underweight | `/api/webhooks/vtiger/final-weight-underweight` | Change only the due date of the exact current Draft `INV-<Deal digits>` from the verified current pickup-date mapping |

Both require the existing private `x-financial-webhook-secret` header (`FINANCIAL_AP_WEBHOOK_SECRET`) and one exact Deal webservice ID, e.g. `{ "deal_id": "5x12345" }`. `record_id` or `id` are accepted only if every supplied ID agrees. The examples are synthetic. No D-number is accepted by a receiver; the admin read-only preview can resolve one exact D-number. Financial/date/customer/direction body data is ignored.

## Verified metadata, not guessed aliases

Authenticated `describeVtigerFinancialModuleFields("Potentials")` succeeded using the existing helper. It performs challenge/session login and metadata GET only. **No record retrieve/query/browse/scan and no Xero call was performed during this verification.**

| Fact | Exact current label | Observed API field | Observed metadata |
| --- | --- | --- | --- |
| D-number | `Deal ID` | `potential_no` | string |
| Named Deal | `Container number` | `potentialname` | mandatory string |
| Linked organisation | `Organization Name` | `related_to` | reference to Accounts |
| Linked contact | `Contact Name` | `contact_id` | reference to Contacts |
| Estimated tonnes | `Estimated Weight (TONS)` | `cf_potentials_weighttons` | double |
| Actual tonnes | `Actual Weight (Tons)` | `cf_potentials_actualweighttons` | double |
| Per-extra-tonne value | `Per Extra Tonne` | `cf_potentials_perextratonne` | multicurrency |
| Underweight due-date source | `Full Container Pickup DATE` | `cf_potentials_fullcontainercollectiondate` | date; display format `dd-mm-yyyy` |
| Source modified timestamp | `Modified Time` | `modifiedtime` | datetime |

`financialFinalWeightAdjustmentSource.ts` resolves these **exact label strings uniquely from current metadata** on every preview/revalidation. It does not hard-code custom-field API names. Missing labels, duplicate labels/API names, reused mapping names or wrong reference/date types hold. The pickup field is required for underweight only. Organisation takes precedence over contact; a malformed organisation cannot be bypassed via contact. Current Deal and linked customer are independently retrieved by exact ID, never by a browse/scan.

**No exact labels remain unresolved after this metadata check.** Metadata does not prove the business agreement that pickup date is the final invoice due date, whether Per Extra Tonne's multicurrency scalar is AUD/GST exclusive in every current Deal, the webservice date serialization, or the source timestamp timezone. Those remain explicit cutover-review prerequisites. Runtime source dates accept valid ISO date-only / ISO midnight representations (and Xero `/Date(...) /` evidence without the space), not locale display parsing or a fallback. If the actual webservice supplies `dd-mm-yyyy`, the branch holds rather than guesses. Numeric source values must be plain finite non-negative decimals, not ambiguous currency-formatted text. The positive excess is `(actual - estimated) × perExtraTonne`, rounded to cents; zero, overflow and direction mismatch hold.

## Exact Draft and line retention contract

- Query only the exact `INV-...` number, **including deleted/voided and other-type matches**, then GET the one matching immutable invoice ID for complete current lines. No new invoice is created when absent.
- Require exactly one current unallocated/unpaid **AUD Exclusive ACCREC DRAFT** with exact ID/number and a uniquely resolved current Deal customer matching its ContactID. Missing, non-Draft, ambiguous or changed evidence holds.
- Retain existing issue/due date, reference, contact, currency, branding and other explicitly supported header fields. Retain every full non-SER70 line, including LineItemID, tracking, discounts, TaxType, TaxAmount and LineAmount; incomplete/full-line-ID collisions hold.
- Overweight replaces every existing case-insensitive SER70 duplicate at the first SER70 position with one canonical positive line; retains the first SER70 LineItemID and drops its stale derived tax/amount/discount/tracking. No other line changes. If none exists, append exactly one. The current exact Xero SER70 sold-item sales account must be active and supply OUTPUT GST; no account 200 assumption enables writing.
- Underweight changes **only DueDate**; all existing lines (including an existing SER70) remain identical. It does not insert a negative amount or remove any line.
- Exact post-transport GET readback checks full retained fields, dates/contact/header, permitted new SER70 net/10% GST, line count and total/tax consistency, and no payment/allocation. An uncertain transport/readback requires reconciliation, not retry.

## Separate handover required

AP release uses only its new isolated flag `FINANCIAL_FINAL_WEIGHT_AUTOMATIC_ENABLED` plus the separate dual-approval policy `financial-automation.final-weight-adjustment-release`. Main Invoice, Deposit, generic canonical routes and global release settings cannot enable it. Both branch booleans and both Operations handovers are required before either route proceeds. No handover or approval was recorded here; follow [the AP handoff](final-weight-adjustment-handoff.md) for future review only.
