# Deposit-to-main deduction root-cause and prevention record — 20 October 2026

## What actually happened

The two records did **not** fail in the same way.

`D702948` completed correctly. Its generic deduction event `120001` is `draft_updated` with writer execution `1320002`, which means the Deposit amount was already subtracted from `INV-702948`.

`D702947` did not reach the deduction writer. Its Deposit and Main Drafts were created, but the generic deduction's first Xero evidence read received HTTP 429 (rate limit). This occurred **before** a deduction reservation, payload binding or Xero amendment request. The system therefore made no change to `INV-702947`; it recorded workflow-failure alert `2010001`, but it did not retain a dedicated generic deduction attempt record explaining that no later automatic attempt was safe.

The original 429 was not a duplicate invoice or an incorrect deduction calculation. Xero defines HTTP 429 as a rate-limit response and supplies a `Retry-After` period for the caller to pause before another request. The rate limit applies to the tenant/application connection, so traffic from another integration or process can contribute even when this application paces its own requests. [1] [2]

## Underlying gap fixed

The existing generic deduction already had correct financial protections: it could amend only two exact matching Xero `ACCREC DRAFT` documents, retained all existing Main Draft lines, added only one GST-balanced deduction line, and never retried an uncertain Xero update. The operational lifecycle around a failed **read before reservation** was incomplete.

The fix closes that gap without weakening Draft-only controls:

- Every generic deduction invocation now writes one append-only local outcome record. It records whether the stop happened at the release check, source read, Xero read, eligibility check, reservation or writer stage. It stores only a redacted reason and safe scalar diagnostic fields; no credentials, request bodies or financial payloads are copied into the new log.
- The four exact Xero invoice GET checks use a strict read-only helper. After a real 429 it can wait and retry **once** only when Xero gave an explicit `Retry-After` of five seconds or less. It cannot submit a POST or PUT, cannot accept an arbitrary callback, and never retries a financial amendment.
- A longer, missing or malformed retry instruction remains a no-write hold. The existing tenant pause and rate-limit state are preserved so other Xero calls stop while the tenant is paused.
- If a deduction has already reserved its immutable event and a later local/bind/writer step fails, the exact reservation is moved to `reconciliation_required`. It cannot remain silently stranded as `reserved`, and it still cannot be replayed.
- Main and Deposit webhooks now raise a durable workflow alert for every deduction result other than `deducted` or `already_deducted`, including `disabled`, `not_ready`, rate-limit holds and reconciliation-required outcomes.

The change adds only one local append-only audit table, `financial_deposit_main_deduction_attempts`, through migration `0055_deposit_main_deduction_attempts.sql`. The table is empty after migration. No historical event, Xero document, customer, source record or financial payload was changed while implementing this fix.

## What is still deliberately not automatic

A rate-limit stop before any Xero amendment does not authorise a later financial update. The system now records and alerts the outcome reliably, but it does not schedule or blindly replay an amendment. A future action still needs fresh current source/Xero evidence and the appropriate approval.

For `D702947`, the current Deposit is now AUTHORISED. The generic deduction intentionally accepts two DRAFT documents only, so it will not amend `INV-702947` based on the earlier state. Any possible correction must be a separately scoped, fresh, Draft-only Main Invoice recovery with a new exact approval. It must never change, authorise, send, pay, void or delete `INV-702947-D`.

## Validation

The focused deduction, Xero rate-manager, Main/Deposit coordinator and webhook suites passed: 140 tests in 7 files. The full offline suite passed: 1,678 tests in 143 files, with 14 intentional live tests skipped. TypeScript, Drizzle schema checks, production build and whitespace/diff checks passed. No external Xero, VTiger, webhook or financial write was made during validation.

## References

[1]: https://developer.xero.com/documentation/best-practices/api-call-efficiencies/rate-limits "Xero API rate limits"
[2]: https://developer.xero.com/documentation/api/accounting/responsecodes "Xero Accounting API response codes"
[3]: https://developer.xero.com/documentation/api/accounting/invoices "Xero Accounting API invoices"
