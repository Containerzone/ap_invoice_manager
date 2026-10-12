# Deposit Invoice — default-off handoff

## Current state

- **Deployment pending:** the approved new-events-only AP-local release policy and `FINANCIAL_DEPOSIT_INVOICE_AUTOMATIC_ENABLED=true` configuration have been recorded. The public receiver accepts the established body-secret format but still returns the safe `deposit-invoice-release-disabled` hold until a fresh checkpoint created after the environment update is published. No Deposit source event or Xero document has been processed while this hold remains.

- AP-only readiness code and standalone administrator **Deposit Invoices** workspace (`/deposit-invoices`). There is **no browser write or release button**. tRPC exposes only administrator query procedures for readiness, exact-current preview and local tracking. Browser previews perform read-only source/accounting evidence checks and do not persist a receipt.
- Dedicated registered protected receiver: `POST /api/webhooks/vtiger/deposit-invoice`, using either the existing AP private header **`x-financial-webhook-secret`** or the established VTiger JSON body `secret`, compared in constant time to `FINANCIAL_AP_WEBHOOK_SECRET`. Invalid/missing authentication returns **401**. `id` can be one exact Deal webservice ID or the existing `potential_no` D-number; a D-number is resolved through one bounded exact lookup only after the independent release gate is valid. No browser/body finance values are trusted.
- Independent writer gate: **`FINANCIAL_DEPOSIT_INVOICE_AUTOMATIC_ENABLED`**. Missing or not exactly `true` returns **503 / held / zero Xero writes**, before source, Xero, local ledger or alerts. Global flags and other financial-family flags cannot release Deposit.
- Config key: `financial-automation.deposit-invoice-release`. Missing policy resolves **disabled**. No policy or flag was created/enabled in this task.
- Additive generated migration: **`drizzle/0042_needy_quasar.sql`**, plus generated `drizzle/meta/0042_snapshot.json` and journal entry. Reviewed: one new table, primary key and three unique constraints only; no ALTER/DROP/backfill/config seed. **Generated only, NOT applied.** Parent must review/apply via managed SQL separately. Do not use `pnpm db:push` because it also migrates.

## Separate future release checklist — not performed

1. Review and apply the additive SQL through the managed AP database process. Verify the new local ledger is empty; do not import/adopt historical Operations invoices.
2. Validate current authenticated read-only `Potentials` metadata and one explicitly named current Deal with business owner approval. Confirm Deposit Status, Deposit Amount Required, both date labels/API names, Deal customer mapping, current Xero `Deposit Required` sales account/tax. Resolve issue-date timezone, conflicting supply/collection precedence and missing-date application default **before broad live use**. Present held cases rather than guessing. See [alignment](operations-deposit-invoice-alignment.md).
3. Obtain explicit approval for the **isolated Deposit Draft only** scope and acknowledged held main-invoice deduction. This is not permission to amend a main invoice or mark CRM Deposit Status paid.
4. In a separately authorised Operations/VTiger change, hand off only the Deposit writer for future events and configure a Deposit-only branch to this exact AP receiver. Do not change Main Invoice, Asset, Customer Sale, Storage, For Hire, Warranty, paid-status handling or any schedule as part of this task. Avoid dual writers.
5. With separate authorisation, store a current AP standing release policy with `releaseKey`, exact `DEPOSIT_INVOICE_RULES_HASH` from code, positive named `approvedBy`, valid non-future `approvedAt` and `effectiveFrom`, `enabled: true`, `depositOnlyVtigerBranch: true`, `operationsDepositHandoff: true`, `sourceMappingsConfirmed: true`, `isolatedDraftOnlyApproved: true`, **`migrationScope: "new_events_only"`**. Invalid scope fails shut. The local read-only UI cannot approve or save this policy.
6. Only after those approvals, separately set **only** `FINANCIAL_DEPOSIT_INVOICE_AUTOMATIC_ENABLED=true`. Leave all global/other-family environment controls unchanged. No Heartbeat/schedule is required for this event family.
7. Verify one newly triggered post-cutover exact current Deal: positive inclusive amount, blank/PENDING status, confirmed dates and customer, empty exact Xero `-D` collision history. AP compares the **Deal's** source timestamp with cutover, not a later customer timestamp; source with old/missing time holds. This boundary is not a historical import/replay authorisation.
8. Confirm a single new exact `INV-<digits>-D` AUD Inclusive **ACCREC Draft**, immutable local event/payload, execution ID and exact Xero read-back. Main deduction must remain visibly held. Reconcile any collision/uncertain result by immutable ID, never suffix/adopt/retry blindly. If needed, separately disable only the Deposit gate; preserve evidence and claim keys.

## Never in this readiness family

- Xero authorisation, payment, sending, deletion, voiding, suffixing or existing invoice adoption.
- Amendment of **any** main invoice, including exact Drafts. The legacy negative deduction needs a separate source/preflight/immutable-safe live path and its own approval. Non-Draft main invoices must never change.
- Paid Deposit Status CRM updates, VTiger mutations/tasks/notes, or post-success mutation queues.
- Historical backfill, catch-up, shared selector activation or all-family go-live.
- Environment edits, Make changes, publishing, external action URL edits, Operations settings or schedule/Heartbeat changes during this implementation.

## Validation

Focused tests cover inclusive GST arithmetic and Draft transport shape; blank/PENDING/positive source eligibility; metadata ambiguity/current record identity; organisation precedence; date holds; Draft/authorised/paid/deleted/voided/ambiguous collisions; independent default-off policy/writer gates; protected receiver authentication and zero-write disabled behavior; append-only evidence, one-time payload binding, exclusive number claims, changed-source/tampered-payload holds; final current-source/Xero GET verification and exact Inclusive AUD Draft read-back. Tests use mocked external services/DB only. No live source preview or accounting request was invoked during development.
