# Deposit Invoice — active new-events-only handoff

## Current state

- **New-events-only release policy is enabled:** the approved AP-local release policy and `FINANCIAL_DEPOSIT_INVOICE_AUTOMATIC_ENABLED=true` configuration are recorded. The public receiver accepts the established body-secret format. The 12 October D702933 credential deployment issue was recovered through a secure re-save and a published public read-path verification before the successful Deposit Draft was created.

- **Transient VTiger login recovery:** Deposit’s read-only source and D-number-resolution paths issue one new `getchallenge`/form-login sequence only when VTiger returns the specific intermittent `Invalid username or password` login response. The retry cannot replay a CRM or Xero write; a second rejection remains a hold. All other errors remain non-retryable.

- AP-only readiness code and standalone administrator **Deposit Invoices** workspace (`/deposit-invoices`). There is **no browser write or release button**. tRPC exposes only administrator query procedures for readiness, exact-current preview and local tracking. Browser previews perform read-only source/accounting evidence checks and do not persist a receipt.
- Dedicated registered protected receiver: `POST /api/webhooks/vtiger/deposit-invoice`, using either the existing AP private header **`x-financial-webhook-secret`** or the established VTiger JSON body `secret`, compared in constant time to `FINANCIAL_AP_WEBHOOK_SECRET`. Invalid/missing authentication returns **401**. `id` can be one exact Deal webservice ID or the existing `potential_no` D-number; a D-number is resolved through one bounded exact lookup only after the independent release gate is valid. No browser/body finance values are trusted.
- Independent writer gate: **`FINANCIAL_DEPOSIT_INVOICE_AUTOMATIC_ENABLED`**. Missing or not exactly `true` returns **503 / held / zero Xero writes**, before source, Xero, local ledger or alerts. Global flags and other financial-family flags cannot release Deposit.
- Config key: `financial-automation.deposit-invoice-release`. Missing/invalid policy resolves **disabled**; the currently recorded policy is enabled solely for this family and for `new_events_only`.
- Additive migration: **`drizzle/0042_needy_quasar.sql`**, plus its generated snapshot/journal, is applied. It adds one local ledger table with a primary key and three uniqueness constraints; it does not alter/backfill financial documents or seed configuration.

## Recorded activation and first-event checklist

1. Additive migration `0042_needy_quasar.sql` is applied and the Deposit ledger is empty; no Operations history was imported or adopted.
2. The approved policy records an isolated Deposit-only VTiger branch, Operations Deposit-writer handover, source mappings, Draft-only approval and `new_events_only` scope. No Heartbeat/schedule was created.
3. A new qualifying post-cutover event must pass current-source and Xero evidence: positive inclusive amount; blank/PENDING Deposit Status; confirmed customer; and no exact `-D` collision history. Empty Container Supply Date and Full Container Collection Date are optional: a sole valid date is the Due Date, equal dates are accepted, and absent/unmapped dates produce a Draft with **no Due Date**. A populated malformed date or conflicting valid dates remains held—AP never guesses a fallback date.
   - If `FINANCIAL_CUSTOMER_CONTACT_AUTOMATIC_ENABLED=true` is deliberately enabled, a zero-match customer may be created once from metadata-proven current Name, Email and Mobile/Phone under a shared idempotent contact ledger. AP force-refreshes customer/invoice/item/account preflight and source evidence before the Draft. Exact name/email conflict, ambiguity, inactive/archived contact, source change or uncertain create is held and operationally alerted; no supplier fuzzy/first-token logic is used.
4. Verify the first accepted event in **Financial Automations → Deposit Invoices**: one `INV-<digits>-D` AUD Inclusive **ACCREC Draft**, immutable event/payload and execution IDs, and exact Xero read-back. The optional Deposit-to-main Draft deduction has its own default-off release and audit lifecycle, described below; it is not enabled by the Deposit creation release.

### Generic Deposit-to-main Draft deduction — prepared, default-off

- Additive migration `0047_shallow_cargill.sql` is applied. It creates one separate `financial_deposit_main_deduction_events` receipt with immutable source/Xero evidence, unique Deposit/main references, one reservation token and one bound update payload. It does not modify any existing event or Xero document.
- Both protected Main and Deposit flows invoke the post-create evaluator only after their own Draft has passed exact Xero read-back. It is order-independent: if one document is not yet AP-owned and complete, it returns **not ready** without a write; the next protected event can evaluate it again.
- A deduction requires two exact current `ACCREC` **DRAFT** documents (`INV-<Deal>` and `INV-<Deal>-D`), AUD, same immutable Xero Contact, unpaid/unallocated one-line inclusive `Deposit Required` Draft, and an AP-owned Main Invoice receipt with the matching immutable Xero ID. Legacy/main invoice adoption is rejected.
- It retains every existing current main-Draft header and line (including Xero line IDs), appends at most one `Less deposit invoice INV-<Deal>-D` negative OUTPUT/account-200 line, and derives its amount from the **read-back Xero Deposit Draft total**. Cents arithmetic sets an exact TaxAmount override so exclusive amount plus GST always equals the inclusive Deposit total; the example $500.00 Deposit becomes -$454.55 net and -$45.45 GST.
- Its independent controls are policy field `mainDraftDeductionApproved: true` **and** `FINANCIAL_DEPOSIT_MAIN_DEDUCTION_AUTOMATIC_ENABLED=true`, in addition to the existing Deposit release. Either missing/false returns disabled before source/Xero reads. Ambiguity, changed evidence, non-Draft/allocated documents, contact mismatch, duplicate lines, uncertain write or read-back mismatch holds; active holds are de-duplicated operational alerts. There is no browser write control, CRM mutation, schedule or retry-by-replay.

### Verified live Deposit event — D702933

After a fresh current-source and Xero preflight, followed by exact user approval, AP created exactly one **ACCREC Draft** `INV-702933-D` for Deal `D702933`: AUD **$500.00 GST-inclusive** ($454.55 subtotal, $45.45 GST), issue date 12 October 2026 and due date 13 October 2026. The immutable Deposit event `30001` and writer execution `180001` are both complete, and Xero read-back is `DRAFT`. An existing single exact Xero customer contact was used; no customer contact was created. No approval, send, payment, void, deletion or VTiger mutation occurred.

### Verified D702933 Draft-only correction

After separate exact user approvals and a fresh source/Xero preflight for each step, AP completed the incident-only correction of the two exact current Drafts. Writer execution `210001` changed only `INV-702933-D`'s existing line description to `Deposit for Q531665 from INV-702933`; an initial local GST-inclusive read-back hold was reconciled only after an independent exact Xero GET confirmed the Draft unchanged except for that description. Writer execution `240001` then appended exactly one `Deposit deduction — INV-702933-D` negative AUD GST-exclusive line to the existing `INV-702933` Draft. Xero’s per-line GST rounding initially returned -$45.46 GST; after a separately approved exact one-cent override, writer execution `270001` changed only that TaxAmount to -$45.45. Final independent Xero read-back: `INV-702933` is still `DRAFT`, with $4,924.86 subtotal, $492.49 GST, **$5,417.35 total**, three lines, and a -$500.00 inclusive Deposit deduction. `INV-702933-D` remains `DRAFT` at $500.00 inclusive. The generic evaluator recognises this earlier incident description as already deducted and will never append a second legacy-format line. No generic deduction release, non-Draft amendment, approval/send/payment, deletion or VTiger mutation is enabled.

## Never in this readiness family

- Xero authorisation, payment, sending, deletion, voiding, suffixing or existing invoice adoption.
- Amendment of **any** main invoice except the completed exact-current-Draft D702933 correction above and a future separately released generic Deposit deduction satisfying every independent guard above. Non-Draft main invoices must never change.
- Paid Deposit Status CRM updates, VTiger mutations/tasks/notes, or post-success mutation queues.
- Historical backfill, catch-up, shared selector activation or all-family go-live.
- Make changes, shared-selector activation, schedule/Heartbeat changes or external action URL edits outside the dedicated Deposit handover.

## Validation

Focused tests cover inclusive GST arithmetic and Draft transport shape; blank/PENDING/positive source eligibility; metadata ambiguity/current record identity; organisation precedence; date holds; Draft/authorised/paid/deleted/voided/ambiguous collisions; independent default-off policy/writer gates; protected receiver authentication and zero-write disabled behavior; append-only evidence, one-time payload binding, exclusive number claims, changed-source/tampered-payload holds; final current-source/Xero GET verification and exact Inclusive AUD Draft read-back. Generic deduction tests cover its separate disabled gate, AP-owned-main requirement, retained-line payload, GST-balanced cents/tax override and recognition of the earlier incident deduction. Automated tests use mocked external services/DB. The separately approved D702933 live creation/correction steps are documented above with independent exact Xero read-back.
