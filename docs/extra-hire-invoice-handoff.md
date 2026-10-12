# Extra Hire Invoice — approved policy, deployment-gated handoff

## Current state

The AP application contains an isolated **Extra Hire Invoices** administrator workspace. Its source preview, release state and AP event tracking are read-only; there is no browser control to release or create an invoice.

- Protected receiver: `POST /api/webhooks/vtiger/extra-hire-invoice`
- Authentication: existing `x-financial-webhook-secret` header **or** the established VTiger JSON `secret` body value, both compared in constant time. A request may carry one exact VTiger Deal webservice ID (`deal_id`, `record_id` or `id`) **or** the existing `potential_no` D-number. The D-number path does one bounded exact AP-side Deal lookup and holds if it is missing or ambiguous; it never searches broadly or selects a record by guesswork. Body amount, rate, date, customer and `dryRun` values are ignored.
- Independent writer gate: `FINANCIAL_EXTRA_HIRE_AUTOMATIC_ENABLED`. When unset/not exactly `true`, an authenticated receiver returns `503` before source, Xero, ledger or alert work.
- Independent policy key: `financial-automation.extra-hire-invoice-release`. A complete, approved `new_events_only` policy is recorded with the current rules/mappings hash, Extra-Hire-only VTiger branch and Operations handover, AP-owned ordinal scheme, Draft-only scope, and no Hire End Date writeback. The separate runtime gate remains the final deployment control.
- Extra Hire CRM writeback is deliberately **not** active. The postcondition is held even if the general storage post-success setting is enabled. `FINANCIAL_EXTRA_HIRE_POST_SUCCESS_ENABLED` is only a future prerequisite; it does not release any conditional VTiger update by itself.

## AP-only data model

The generated migration `drizzle/0044_curved_baron_strucker.sql` adds one local ledger table, `financial_extra_hire_invoice_events`. It contains immutable source/preflight/payload evidence, the exact source Hire End Date, AP ordinal and exclusive period/ordinal/invoice claims. It does not alter `extra_hire_runs`, because that older table contains shadow evidence and must not establish live eligibility.

The migration is additive only: one `CREATE TABLE`, primary key and four unique indexes. It was reviewed and applied through the managed AP SQL process on 11 October 2026. Do not use `pnpm db:push`.

## Proposed Draft rules

Only a current exact Deal meeting every condition can be proposed:

| Requirement | AP enforcement |
|---|---|
| Hire Duration | Exact current VTiger picklist value `30 days` only |
| Container | Current 20- or 40-foot supported container and non-empty container number |
| Customer | Exact linked organisation first, otherwise exact linked contact |
| Dates | ISO Hire End Date and offset-bearing current source timestamp only; no locale/timezone guess |
| Xero item | Current exact `20' Hire` or `40' Hire` sales item, active account and `OUTPUT` tax evidence |
| Draft | New AUD, GST-exclusive `ACCREC` Draft with one `4.286`-week line and current Xero item rate |
| Number | Approved `EH_AP_ORDINAL_V1`: `INV-<Deal digits>-EH1`, then only contiguous AP-owned next ordinals |

`-D` is never used by Extra Hire because it belongs to Deposit. An existing/deleted/voided/changed/ambiguous Extra Hire number, a missing period, a historical unowned invoice or a gap in the AP ordinal chain is a **hold**, not a reason to skip a suffix or adopt an invoice.

The current hire end date is used as the Draft issue date and no due date is inferred. This requires the future policy to acknowledge `CURRENT_HIRE_END_DATE_NO_DUE_DATE` after business confirmation.

## Activation verification checklist

1. Confirm the applied ledger starts empty and has no historical import.
2. Validate one named current Deal using AP read-only preview. Confirm the current VTiger date serialization/timezone and the exact Xero customer, hire item, rate, account and `OUTPUT` tax evidence.
3. Confirm `EH_AP_ORDINAL_V1` as the approved replacement for legacy Extra Hire suffix/revision behavior. This is required before the first Draft and cannot be assumed from old records.
4. In separately authorised external work, pause/handover only the Operations/Make Extra Hire writer and configure an Extra-Hire-only VTiger branch to the protected AP receiver. Do not change any other financial branch.
5. [x] Recorded the explicit, new-events-only policy with the current rules hash, source-mapping hash, `extraHireOnlyVtigerBranch`, `operationsExtraHireHandoff`, `invoiceSuffixCollisionSchemeConfirmed`, `suffixScheme: "EH_AP_ORDINAL_V1"`, `isolatedDraftOnlyApproved`, `postSuccessHireEndDateAcknowledged` and `dateSemantics: "CURRENT_HIRE_END_DATE_NO_DUE_DATE"`.
6. [ ] Set **only** `FINANCIAL_EXTRA_HIRE_AUTOMATIC_ENABLED=true` after the approved activation checkpoint is published, then test both the public receiver and a deliberately nonexistent exact Deal with zero Xero writes.
7. [ ] Verify the first post-cutover event produces exactly one `INV-…-EH1` Draft with complete immutable evidence and exact Xero read-back. Reconcile any uncertainty by ledger ID; never retry, skip or adopt blindly.
8. Treat the VTiger Hire End Date +30-day update as a separate future design/release. It is not authorised by the Extra Hire invoice release.

## Explicit exclusions

- No invoice authorisation, sending, payment, voiding, deletion, suffix bypass or historical import.
- No recurring schedule/Heartbeat.
- No automatic VTiger Hire End Date change, note or task.
- No activation of a generic financial family or use of Storage post-success permissions.
