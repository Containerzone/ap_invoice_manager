# Deposit Invoice — active new-events-only handoff

## Current state

- **Live for new events only:** the approved new-events-only AP-local release policy and `FINANCIAL_DEPOSIT_INVOICE_AUTOMATIC_ENABLED=true` configuration are published. The public receiver accepts the established body-secret format. A deliberately nonexistent D-number was held by the bounded exact VTiger lookup with `xeroWritesAttempted: 0`, proving the enabled receiver does not create a document for an unresolvable source.

- AP-only readiness code and standalone administrator **Deposit Invoices** workspace (`/deposit-invoices`). There is **no browser write or release button**. tRPC exposes only administrator query procedures for readiness, exact-current preview and local tracking. Browser previews perform read-only source/accounting evidence checks and do not persist a receipt.
- Dedicated registered protected receiver: `POST /api/webhooks/vtiger/deposit-invoice`, using either the existing AP private header **`x-financial-webhook-secret`** or the established VTiger JSON body `secret`, compared in constant time to `FINANCIAL_AP_WEBHOOK_SECRET`. Invalid/missing authentication returns **401**. `id` can be one exact Deal webservice ID or the existing `potential_no` D-number; a D-number is resolved through one bounded exact lookup only after the independent release gate is valid. No browser/body finance values are trusted.
- Independent writer gate: **`FINANCIAL_DEPOSIT_INVOICE_AUTOMATIC_ENABLED`**. Missing or not exactly `true` returns **503 / held / zero Xero writes**, before source, Xero, local ledger or alerts. Global flags and other financial-family flags cannot release Deposit.
- Config key: `financial-automation.deposit-invoice-release`. Missing/invalid policy resolves **disabled**; the currently recorded policy is enabled solely for this family and for `new_events_only`.
- Additive migration: **`drizzle/0042_needy_quasar.sql`**, plus its generated snapshot/journal, is applied. It adds one local ledger table with a primary key and three uniqueness constraints; it does not alter/backfill financial documents or seed configuration.

## Recorded activation and first-event checklist

1. Additive migration `0042_needy_quasar.sql` is applied and the Deposit ledger is empty; no Operations history was imported or adopted.
2. The approved policy records an isolated Deposit-only VTiger branch, Operations Deposit-writer handover, source mappings, Draft-only approval and `new_events_only` scope. No Heartbeat/schedule was created.
3. A new qualifying post-cutover event must pass current-source and Xero evidence: positive inclusive amount; blank/PENDING Deposit Status; confirmed dates/customer; and no exact `-D` collision history. Old/missing source time, ambiguity, collision or changed source must remain held.
4. Verify the first accepted event in **Financial Automations → Deposit Invoices**: one `INV-<digits>-D` AUD Inclusive **ACCREC Draft**, immutable event/payload and execution IDs, exact Xero read-back, and a visibly held main-invoice deduction. No suffix/adoption/amendment/retry is permitted.

## Never in this readiness family

- Xero authorisation, payment, sending, deletion, voiding, suffixing or existing invoice adoption.
- Amendment of **any** main invoice, including exact Drafts. The legacy negative deduction needs a separate source/preflight/immutable-safe live path and its own approval. Non-Draft main invoices must never change.
- Paid Deposit Status CRM updates, VTiger mutations/tasks/notes, or post-success mutation queues.
- Historical backfill, catch-up, shared selector activation or all-family go-live.
- Make changes, shared-selector activation, schedule/Heartbeat changes or external action URL edits outside the dedicated Deposit handover.

## Validation

Focused tests cover inclusive GST arithmetic and Draft transport shape; blank/PENDING/positive source eligibility; metadata ambiguity/current record identity; organisation precedence; date holds; Draft/authorised/paid/deleted/voided/ambiguous collisions; independent default-off policy/writer gates; protected receiver authentication and zero-write disabled behavior; append-only evidence, one-time payload binding, exclusive number claims, changed-source/tampered-payload holds; final current-source/Xero GET verification and exact Inclusive AUD Draft read-back. Tests use mocked external services/DB only. No live source preview or accounting request was invoked during development.
