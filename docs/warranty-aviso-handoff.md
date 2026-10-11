# Warranty & Aviso — AP-only readiness handoff

## Checkpoint and authority

**Testable, default-off readiness implementation only. Not activated, published or a production cutover.** This continuation was limited to `/home/ubuntu/ap_invoice_manager`, local code/tests and documentation. No release policy or persistent environment flag was changed. No Operations/Make/VTiger configuration, schedule, Heartbeat or external system was changed.

**No external HTTP was performed by this continuation.** Tests and builds ran in disconnected Linux network namespaces. All new financial/CRM transport, authentication, source and database paths exercised by tests were mocks. There were no real Xero writes, source record reads/mutations, policy writes or database migration/application calls.

## Delivered surfaces

- Dedicated authenticated POST receiver: `/api/webhooks/vtiger/warranty-aviso`.
- Exact event `warranty.aviso-requested` and one logical Deal webservice ID (`deal_id`, `record_id` or `id`; multiple aliases must all agree). Financial/customer/body eligibility claims cannot authorize a write.
- Standalone administrator page **Warranty & Aviso**, `/warranty-aviso`, and administrator-only tRPC query procedures `financialOperations.previewWarrantyAviso`, `warrantyAvisoReadiness` and `warrantyAvisoEvents`. No browser write, release, retry or reconciliation-control procedure.
- Isolated rules, source, release, Xero evidence, immutable AP event ledger, service and dedicated writer modules. Legacy `warranty_documents` is not read, imported or used as AP authority.

**“Read-only” means no financial/CRM document writes, not a side-effect-free preview.** `previewWarrantyAviso` performs current metadata/exact source/accounting reads when configured and inserts a new immutable local AP preview/hold event. Identity login/OAuth refresh and existing read-cache activity are also possible if actually invoked later. `noWrites: true` is a financial/CRM document-write contract, not a promise of zero local ledger writes. Readiness is policy-read-only; events is bounded local ledger SELECT-only. No real preview was invoked in this continuation.

## Migration 0045 — generated, inspected and applied locally

`drizzle/0045_slow_archangel.sql`, its snapshot and journal entry were generated in the scaffolding and then reviewed. The additive AP-local migration was applied through the managed AP SQL tool on 11 October 2026; `db:push` and unmanaged migration commands were not used.

The SQL contains one additive `CREATE TABLE financial_warranty_aviso_events`, **20 columns**, a primary key and two unique constraints (`eventKey` and nullable `claimKey`). No ALTER, DROP, backfill, policy insertion or activation SQL. SQL SHA-256: `339a29baa949e658f6c20ca400dabc91dfd910bb6a09d3ca2f99c0a7aee8fc62`.

The table now exists and a read-only verification returned **0 events / 0 execution-or-receipt rows**. This proves only the empty initial local ledger state; it does not prove real concurrent reservation, crash recovery or Xero normalization behavior.

## Release and disabled boundaries

The dedicated gate requires **both** `FINANCIAL_WARRANTY_AUTOMATIC_ENABLED === "true"` and the separately approved config row `financial-automation.warranty-aviso-release`, whose `releaseKey` must equal that exact dedicated key. Generic/global/Main/Storage authorization cannot substitute.

A valid policy additionally requires the exact current rules hash, positive resolved approver, valid nonfuture approval/cutover dates, `migrationScope: "new_events_only"`, explicit Draft-main amendment approval, isolated Draft-only scope, warranty-only VTiger branch, Operations/Make handover and Main Invoice coordination acknowledgments, no CRM post-success mutation, approved source/Added Services mapping hashes and exact approved Aviso/Xero configuration hash/contact/name/account.

- Unauthenticated requests return **401** before policy/service/source/Xero paths.
- Authenticated requests with an unset/nonliteral-true dedicated flag return **503**, held with zero writes, before body parsing, policy lookup or source/service paths.
- Flag true but missing/invalid/unavailable policy returns **503** after at most the local policy lookup, before service/source/Xero paths.
- Invalid exact event/ID returns **400** only after the two release gates.
- An uncertain service failure reports reconciliation, never falsely asserts that transport attempts were zero.

Test environment stubs are temporary and restored; they are not deployment settings or approvals.

## Dedicated writer and immutable lifecycle

Allowed operations are only:

1. `PUT /Invoices/<exact immutable main ID>`: retain the current unallocated **AUD Exclusive ACCREC DRAFT** `INV-<Deal digits>` and every original supported full line/header/date; append exactly one native approved WAR line.
2. Only after successful main full-document readback: `POST /PurchaseOrders`, creating the exact **AUD Exclusive DRAFT** Aviso `I<Deal digits>` PO using purchase account `313`, `INPUT` GST and the same native description/exclusive premium.

No absent-main create, non-Draft amendment, suffix path, historical adoption, second WAR append, conflicting I-reference adoption or CRM post-success write is implemented. Non-Draft handling explicitly holds for the **unimplemented** `WARRANTY_AP_SUFFIX_V1` path; that name is not an authorization or available capability.

Authorization independently binds the dedicated family/step/reservation/release/approver to immutable policy, source, preflight, rebuilt proposal and exact payload hashes, a five-minute reservation window and New Events cutover. It re-reads current exact source/customer metadata and full current Xero evidence before transport. Exact line IDs, descriptions, quantities, discounts, tracking, accounts, tax, totals, retained header fields and dates remain checked; no line/header/readback controls were loosened.

**Both `authorizeWarrantyWrite` and `consumeWarrantyStep` require a `main_receipt` whose `receipt.readbackVerified === true` before PO.** Presence of a receipt, response ID or truthy string/number is insufficient. The writer records `true` only after `assertWarrantyReadback` succeeds on the full document. HTTP success plus failed/unavailable/mismatched full readback records `false` and reconciliation; a PO is blocked. Even a verified prior receipt does not skip current full-main revalidation immediately before PO.

Ledger lifecycle is insert-only: new preview/hold evidence → unique lifetime `warranty:<Deal number>` claim/reservation → unique main attempt/receipt → unique PO attempt/receipt → `drafts_created` or terminal `reconciliation_required`. Consumption precedes HTTP. Transient transport retry is explicitly disabled. Partial/uncertain pairs retain claims, attempted-operation receipts and terminal reconciliation rather than clearing authority or retrying. No reconciliation/retry/reset action is exposed.

## Unproven actual configuration — held

**Actual source configuration and Xero item/tax values remain unproven and held.** No metadata or Xero external call was made to establish them. Synthetic test names (`cf_test_added`, `WAR-TEST`), premium 100 and synthetic contact/tenant/account evidence are not production mapping or approval.

Separate review must prove the actual Potentials ID prefix; exact unique Deal/Added Services/linked-customer/Modified Time full metadata bindings; full Added Services picklist; exactly one approved value-to-native-WAR-description/exclusive-premium mapping; issue/due source or preserve-main semantics; offset-bearing source/customer timestamps and actual new-event meaning. `Warranty Confirmed` is deliberately not a source or eligibility fallback.

Also unproven: actual Aviso ContactID; native WAR item sold/purchased flags, sales/purchase descriptions and premiums; sales account; actual active purchase account 313; active 10% INPUT/OUTPUT tax evidence; exact tenant and collision history. Constants are requirements, not live validation. Preserve the held release until separately approved evidence/hashes and handovers exist.

## Validation

Final local validation (all financial transport mocked; networking disabled):

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | Passed, exit 0 |
| Focused `financialWarrantyAviso*.test.ts` | **8 files / 258 tests passed** |
| `pnpm vitest run --exclude server/microsoftGraphConfig.test.ts` | **112 files / 1,158 tests passed** |
| `pnpm build` | Passed, exit 0; client and bundled server generated locally |
| `git diff --check` | Passed |

Six new mocked test files contribute **181 tests** (release 46, webhook 37, writer 50, service 17, database 18, router 13); existing rules/source tests add 77. Tests cover strict receipt transition, full-readback failure, partial terminal pair/no retry, generic/tampered/missing authority, factual configuration holds, pre-existing claims, pre-cutover holds and administrator query-only contracts.

One initial full-suite run lost the existing process environment during privilege isolation: **106 files / 1,135 tests passed; 6 files / 23 tests failed**. Re-running with the existing environment preserved, without changing any settings, passed all **112 / 1,158**. The credential-dependent Microsoft Graph file was excluded as requested and not executed. Build warnings concern pre-existing analytics placeholders, CSS import ordering, large bundles and pnpm settings; they do not constitute publication or validation of production services.

## Remaining limitations and future review, not authorization

- Database uniqueness/insert-only behavior was exercised with Drizzle mocks; the applied empty table was verified, but real concurrency, crash recovery and transaction integration remain unproven.
- Full-line Xero PUT/POST response and server-normalization behavior has only mocked coverage; verify an explicitly authorized non-production fixture later.
- No cross-system lock prevents a legacy writer/operator from racing the final GET and PUT. Separate warranty writer handover **and** Main Customer Invoice warranty-entry coordination are required.
- A Deal modified timestamp alone does not prove a warranty business event occurred after cutover. Delivery/new-event semantics require separate sign-off.
- Real UI/service previews are not proven usable until actual source configuration review is complete.
- External verification, approval, cutover, activation or publication remains separate work and must be explicitly authorized.

See [Operations alignment](operations-warranty-aviso-alignment.md) and the factual checkpoint appended to `todo.md`.
