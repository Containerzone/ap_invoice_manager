# Final Weight Adjustments — AP-only handoff

## Implementation checkpoint

**Default-off implementation/readiness only. Not activated or published.** Work is isolated to `/home/ubuntu/ap_invoice_manager`.

- Two dedicated private POST routes: `/api/webhooks/vtiger/final-weight-overweight` and `/api/webhooks/vtiger/final-weight-underweight`. Each accepts either the standard `x-financial-webhook-secret` header or the existing VTiger JSON `secret` field; the private value is compared in constant time and never stored or logged. `dryRun` is accepted only for VTiger body compatibility and is never trusted as an AP safety control.
- Standalone administrator sidebar page **Final Weight Adjustments**, `/final-weight-adjustments`: branch status cards, exact named Deal GET-only preview, source mappings/full original and expected Draft payload evidence, and event/hold tracking. No browser mutation/release button.
- Administrator-only tRPC **query** procedures: `financialOperations.finalWeightReadiness`, `finalWeightEvents`, `previewFinalWeightAdjustment`. Preview does **not** insert/update final-weight evidence, execution or policy. Existing read helpers may refresh OAuth authentication/cache GET responses; this is not financial ledger evidence or CRM/accounting document mutation.
- Pure source/rules modules, isolated immutable event/claim database module and service; dedicated Draft-only PUT authorization in `financialProductionWriter`; existing exact Xero GET readback extended only with final-weight full retained-payload validation.
- Generic canonical final-weight routes/evaluator, financialAutomationRules, Main Invoice/Deposit release policies, environment flags, Operations/VTiger/Make settings, schedules and Heartbeat are unchanged.

## Migration — generated and inspected, NOT applied

`drizzle/0043_glamorous_vampiro.sql` was generated from `drizzle/schema.ts` using `pnpm drizzle-kit generate`. The generated migration contains **only one additive CREATE TABLE**, `financial_final_weight_adjustment_events`, 30 columns, primary key and four unique indexes. No ALTER, DROP, data backfill, policy INSERT or activation statement. Generated snapshot/journal are included.

**Parent must review and apply through `webdev_execute_sql` separately. Do not run `db:push`, drizzle migrate or auto-apply.** Until applied, ledger listing intentionally reports unavailable; no successful execution is assumed.

Ledger factual evidence is append-only via an evidence-key no-op duplicate insert: direction, exact Deal/number, exact existing invoice ID/number, source/rules/preflight hashes, source and full preflight snapshots, original/expected payload and their hashes. Only lifecycle fields change.

`previewed / held → reserved → submitted → draft_updated` or `reconciliation_required` preserves holds. Nullable unique claimed Deal ID, invoice ID and invoice number are **shared across both directions**, preventing a second payload/other-branch amendment for the same main document. Claims never clear, including failures. Payload binds once using the reservation token; submission consumes it atomically once and disables transient transport retries. No retry/release/reconciliation action is exposed to the browser. Manual reconciliation is a separately reviewed future operational process, not a mechanism to clear claims and rewrite.

## Writer boundary

This does not enable a generic invoice update path. The dedicated authorisation requires:

1. `FINANCIAL_FINAL_WEIGHT_AUTOMATIC_ENABLED === "true"` **and** a current separately approved final-weight policy.
2. Exact final-weight workflow, direction, immutable event ID, policy release key and approver; no other-family event authorization.
3. Exactly one existing **AUD Exclusive ACCREC DRAFT** main invoice `PUT /Invoices/<verified ID>` with matching InvoiceID/InvoiceNumber/ContactID, retained dates and complete line evidence. No create, purchase order, suffix/-D or other update type.
4. Independent current metadata/Deal/customer re-read and exact Xero number/contact/item/full-ID preflight rebuild; compare source, rules, preflight and original/expected/payload hashes with the reservation before transport.
5. One-shot submitted CAS and no transient gateway retry; exact GET full-payload readback before success. Uncertainty retains exclusive claims and payload for reconciliation. No CRM post-success action is queued.

The Xero current Draft can change between the last GET and PUT because AP has no cross-system atomic lock. The code minimizes this with repeated fresh source/Xero validation and exact readback, but cannot prevent an outside legacy writer/operator from racing it. **Both Operations handovers are essential.** Full-line PUT/Xero server-normalization semantics have only been exercised with mocks, not real documents; verify safely in a separately authorised non-production fixture before any release. Conservative source/date/retained-header normalization differences hold rather than permit a blind retry.

## Dual gate / zero-impact disabled routes

The new environment flag is **unset** in this checkpoint (not modified). When unset/not `true`, an authenticated valid exact-ID receiver returns **503** before any source/metadata/Xero/DB read or write. Unauthenticated requests return **401** first. Malformed authenticated ID envelopes return **400** without reads/writes.

If someone later sets the flag but the policy is missing/invalid, both routes return **503** after only a local policy SELECT, before evidence/claim writes or upstream calls. No flag or policy was set by this work.

The separate config key is `financial-automation.final-weight-adjustment-release`. Policy fields are **only**:

- `releaseKey`, `rulesHash`, `enabled`, `approvedBy`, `approvedAt`, `effectiveFrom`
- `overweightVtigerBranch`, `underweightVtigerBranch`
- `operationsOverweightHandoff`, `operationsUnderweightHandoff`
- `sourceMappingsConfirmed`, `draftOnlyUpdateApproved`
- `migrationScope: "new_events_only"`

Both branches/handoffs must be true. Missing/invalid/future approval/effective dates, wrong key/hash or historical scope fail shut. An old Deal modified timestamp before the cutover is held without reservation; no historical adoption/import is attempted. Timestamp semantics and genuine new-event delivery must be reviewed separately; a generic Deal modified timestamp alone is not proof that a final-weight business event occurred after cutover.

## Source mapping evidence and remaining review

See [Operations final-weight alignment](operations-final-weight-alignment.md) for the exact labels/API names observed through **metadata-only describe** on 2026-10-11. No exact label is unresolved. Required current facts are named D-number Deal, linked Deal customer, actual/estimated weights, per-extra-tonne and underweight pickup date. Runtime uniqueness/type/scalar checks hold on drift/absence/ambiguity.

Before a future release, independently confirm:

- **Full Container Pickup DATE is the agreed underweight due-date source.** No alternative/fallback is implemented.
- Plain numeric multicurrency Per Extra Tonne is the authorised **AUD GST-exclusive** rate; actual/estimated fields are tonnes; business rounding is cents.
- Actual VTiger webservice date serialization and modified timestamp timezone/event semantics. Locale display format is not guessed.
- Current exact SER70 sales-item account, OUTPUT tax and full-line PUT/readback normalization in a safe separately authorised fixture.
- Both dedicated VTiger branch handovers for new events only, and both legacy Operations writers paused/handover-complete through separately authorised Operations work.
- Obtain explicit isolated **Draft amendment** approval, record the policy with the current rules hash, then consider only the dedicated flag. None of these steps is authorised by this implementation task.

## Validation and side effects

Focused mock tests cover pure rules, source label/name/type ambiguity, full line retention and SER70 duplicate replacement, due-date-only/no negative changes, non-Draft/paid/allocated/missing/ambiguous/collision holds, exclusive immutable payload claims, one-shot writer update isolation, 401/503 no-write routes, administrator query authorization, readback and reconciliation. All financial transport tests use mocks; no external records are used.

Final validation results are recorded in the appended `todo.md` checkpoint. The only direct upstream call during implementation was the existing read-only **Potentials metadata describe** helper (challenge/session login plus describe GET). No Deal/customer record was browsed/retrieved/scanned, no Xero call was made by implementation commands, no real financial/CRM document was created/amended, no migration was applied, and nothing was published or activated.
