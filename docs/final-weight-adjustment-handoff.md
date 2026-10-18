# Final Weight Adjustments — AP-only handoff

## Implementation checkpoint

**Published current-event activation.** The additive ledger migration and approved Final Weight policy are applied, and `FINANCIAL_FINAL_WEIGHT_AUTOMATIC_ENABLED=true` is deployed for new events only. Current protected receivers use the corrected exact-resource POST path. Historical 404 records remain independently locked for reconciliation; no historical Draft has been replayed through normal webhooks.

- Two dedicated private POST routes: `/api/webhooks/vtiger/final-weight-overweight` and `/api/webhooks/vtiger/final-weight-underweight`. Each accepts either the standard `x-financial-webhook-secret` header or the existing VTiger JSON `secret` field; the private value is compared in constant time and never stored or logged. The named `id`/`record_id`/`deal_id` may be one exact current Deal webservice ID or legacy `D…` number. A D-number is resolved only through one AP-side bounded exact Potentials lookup after the Final Weight release policy is valid; ambiguity/not-found holds. `dryRun` is accepted only for VTiger body compatibility and is never trusted as an AP safety control.
- Standalone administrator sidebar page **Final Weight Adjustments**, `/final-weight-adjustments`: branch status cards, exact named Deal GET-only preview, source mappings/full original and expected Draft payload evidence, and event/hold tracking. No browser mutation/release button.
- Administrator-only tRPC **query** procedures: `financialOperations.finalWeightReadiness`, `finalWeightEvents`, `previewFinalWeightAdjustment`. Preview does **not** insert/update final-weight evidence, execution or policy. Existing read helpers may refresh OAuth authentication/cache GET responses; this is not financial ledger evidence or CRM/accounting document mutation.
- Pure source/rules modules, isolated immutable event/claim database module and service; dedicated Draft-only exact-resource **POST** update authorization in `financialProductionWriter`; existing exact Xero GET readback extended only with final-weight full retained-payload validation.
- Generic canonical final-weight routes/evaluator, financialAutomationRules, Main Invoice/Deposit release policies, environment flags, Operations/VTiger/Make settings, schedules and Heartbeat are unchanged.

## Migration — generated, inspected and applied

`drizzle/0043_glamorous_vampiro.sql` was generated from `drizzle/schema.ts` using `pnpm drizzle-kit generate`. The generated migration contains **only one additive CREATE TABLE**, `financial_final_weight_adjustment_events`, 30 columns, primary key and four unique indexes. No ALTER, DROP, data backfill, policy INSERT or activation statement. Generated snapshot/journal are included.

The additive migration was applied through `webdev_execute_sql`. No `db:push`, broad migrate, data backfill, policy seed or financial document change was used.

Ledger factual evidence is append-only via an evidence-key no-op duplicate insert: direction, exact Deal/number, exact existing invoice ID/number, source/rules/preflight hashes, source and full preflight snapshots, original/expected payload and their hashes. Only lifecycle fields change.

`previewed / held → reserved → submitted → draft_updated` or `reconciliation_required` preserves holds. Nullable unique claimed Deal ID, invoice ID and invoice number are **shared across both directions**, preventing a second payload/other-branch amendment for the same main document. Claims never clear, including failures. Payload binds once using the reservation token; submission consumes it atomically once and disables transient transport retries. No retry/release/reconciliation action is exposed to the browser. Manual reconciliation is a separately reviewed future operational process, not a mechanism to clear claims and rewrite.

## Writer boundary

This does not enable a generic invoice update path. The dedicated authorisation requires:

1. `FINANCIAL_FINAL_WEIGHT_AUTOMATIC_ENABLED === "true"` **and** a current separately approved final-weight policy.
2. Exact final-weight workflow, direction, immutable event ID, policy release key and approver; no other-family event authorization.
3. Exactly one existing **AUD Exclusive ACCREC DRAFT** main invoice `POST /Invoices/<verified ID>` with matching InvoiceID/InvoiceNumber/ContactID, retained dates and complete line evidence. For future overweight events only, its Reference is set to the current Deal's non-empty Customer PO, otherwise the current Deal's Container number; no other source or existing-Reference fallback is permitted. Underweight retains Reference unchanged. Xero uses that exact-resource POST to update an existing invoice; collection-level POST/PUT and all create paths are rejected. No purchase order, suffix/-D or other update type is permitted.
4. Independent current metadata/Deal/customer re-read and exact Xero number/contact/item/full-ID preflight rebuild; compare source, rules, preflight and original/expected/payload hashes with the reservation before transport.
5. One-shot submitted CAS and no transient gateway retry; exact GET full-payload readback before success. Uncertainty retains exclusive claims and payload for reconciliation. No CRM post-success action is queued.

The Xero current Draft can change between the last GET and exact-resource POST because AP has no cross-system atomic lock. The code minimizes this with repeated fresh source/Xero validation and exact readback, but cannot prevent an outside legacy writer/operator from racing it. **Both Operations handovers are essential.** Full-line Xero update/readback normalization semantics have only been exercised with mocks, not real documents; verify safely in a separately authorised non-production fixture before any release. Conservative source/date/retained-header normalization differences hold rather than permit a blind retry.

## Dual gate / zero-impact disabled routes

The independent `FINANCIAL_FINAL_WEIGHT_AUTOMATIC_ENABLED` flag is securely set to **`true`** and published. With the approved policy, only either dedicated Final Weight route can proceed to exact current evidence. Unauthenticated requests return **401** first; malformed authenticated ID envelopes return **400** without reads/writes.

If the policy is missing/invalid, both routes return **503** after only a local policy SELECT, before evidence/claim writes or upstream calls. The policy retains both VTiger branches, both Operations handovers, exact mappings, Draft-only approval and `new_events_only` scope. The future overweight-only Reference policy is bound to rules v3's hash; the pre-existing v2 policy record is not changed by this implementation and cannot authorize v3 until separately approved with the current hash.

The separate config key is `financial-automation.final-weight-adjustment-release`. Policy fields are **only**:

- `releaseKey`, `rulesHash`, `enabled`, `approvedBy`, `approvedAt`, `effectiveFrom`
- `overweightVtigerBranch`, `underweightVtigerBranch`
- `operationsOverweightHandoff`, `operationsUnderweightHandoff`
- `sourceMappingsConfirmed`, `draftOnlyUpdateApproved`
- `migrationScope: "new_events_only"`

Both branches/handoffs must be true. Missing/invalid/future approval/effective dates, wrong key/hash or historical scope fail shut. An old Deal modified timestamp before the cutover is held without reservation; no historical adoption/import is attempted. Timestamp semantics and genuine new-event delivery must be reviewed separately; a generic Deal modified timestamp alone is not proof that a final-weight business event occurred after cutover.

## Source mapping evidence and remaining review

See [Operations final-weight alignment](operations-final-weight-alignment.md) for the exact labels/API names observed through **metadata-only describe** on 2026-10-11. No exact label is unresolved. Required current facts are named D-number Deal, linked Deal customer, actual/estimated weights, per-extra-tonne and underweight pickup date; overweight additionally requires the string Customer PO mapping, although a blank current value falls back only to the named Deal's Container number. Runtime uniqueness/type/scalar checks hold on drift/absence/ambiguity.

Before a future release, independently confirm:

- **Full Container Pickup DATE is the agreed underweight due-date source.** No alternative/fallback is implemented.
- Plain numeric multicurrency Per Extra Tonne is the authorised **AUD GST-exclusive** rate; actual/estimated fields are tonnes; business rounding is cents.
- Actual VTiger webservice date serialization and modified timestamp timezone/event semantics. Locale display format is not guessed.
- Current exact SER70 sales-item account, OUTPUT tax and full-line exact-resource POST/readback normalization in a safe separately authorised fixture.
- Both dedicated VTiger branch handovers for new events only, and both legacy Operations writers paused/handover-complete through separately authorised Operations work.
- Obtain explicit isolated **Draft amendment** approval, record the policy with the current rules hash, then consider only the dedicated flag. None of these steps is authorised by this implementation task.

## Validation and side effects

Focused mock tests cover pure rules, source label/name/type ambiguity, full line retention and SER70 duplicate replacement, due-date-only/no negative changes, non-Draft/paid/allocated/missing/ambiguous/collision holds, exclusive immutable payload claims, one-shot writer update isolation, 401/503 no-write routes, administrator query authorization, readback and reconciliation. All financial transport tests use mocks; no external records are used.

Final validation results are recorded in the appended `todo.md` checkpoint. The activation validation additionally used two authenticated local safe probes with a deliberately nonexistent exact Deal ID—one for each route. Both exercised the canonical body `id`/`secret` envelope and bounded VTiger read path, held with zero Xero writes, and did not create a CRM/accounting record. After publication, repeat that public safe probe before accepting the first real qualifying post-cutover event.

## Operational hold notification

For an active Final Weight route, an invalid/missing exact Deal reference, a source/preflight hold or an execution exception is persisted through the existing de-duplicated operational-failure service and emailed to the configured user/technical-team recipients once per active failure window. The notification contains only direction, Deal webservice ID (when valid) and held state—never credentials, raw webhook data or customer data. Disabled-route checks and `dryRun: true` safe probes do not alert.

## Legacy D-number compatibility preflight

The legacy VTiger body used `id: "D702915"` and was previously rejected before any source read because the receiver only accepted a webservice ID. The compatibility update is bounded to that exact D-number form and does not permit a browse, finance values from the body, name matching or a fallback candidate. A read-only preflight on 2026-10-12 resolved the one exact current Deal and the exact current Xero Draft `INV-702915`; the Overweight route is eligible to replace/add only its controlled `SER70` excess-weight line by **AUD 207.10 GST-exclusive** (GST 20.71; Draft total increase 227.81). This is preflight evidence only, not approval to amend the Draft. Obtain a fresh current preflight and explicit confirmation of that exact Draft exact-resource POST after the compatibility checkpoint is published.

## 2026-10-12 transport correction and reconciliation hold

The first D702915 delivery resolved its exact current Deal and reached one guarded Xero update request, but Xero returned HTTP 404 to `PUT /Invoices/<verified ID>`. The local immutable event is therefore `reconciliation_required`; its one-shot claim remains consumed and **must never be retried**. An immediate read-only Xero check confirmed the target remains the same unpaid `DRAFT` invoice with its original line only, so no Draft amendment was applied.

Xero’s Accounting API specifies **POST** to update an existing invoice and reserves **PUT** for creating new invoices. Final Weight rules v2 restrict future amendments to `POST /Invoices/<verified ID>` only—the exact resource path remains mandatory and collection-level POST/PUT remains rejected. This correction is supported by Xero’s official request-method guide and invoices reference: <https://developer.xero.com/documentation/api/accounting/requests-and-responses> and <https://developer.xero.com/documentation/api/accounting/invoices>.

The AP-local Final Weight policy was explicitly set to `enabled: false` while this correction was pending publication. After checkpoint `be035d53` was published, the separately approved policy was restored with rules v2’s hash and retains its `new_events_only` scope. Authenticated public probes for both routes then reached the active receiver and held a deliberately nonexistent exact Deal (`202`); neither route created an event/execution or called Xero. D702915 remains reconciliation-required and must not be replayed as part of this correction.

## Individually approved legacy-404 recovery — prepared, default-off

The protected current-event receivers already use the corrected exact-resource `POST` path. Two historical records, D702915 Overweight and D702934 Underweight, reached Xero only with the superseded `PUT` method and therefore correctly remain `reconciliation_required`; their original invoice claims, failed executions and source evidence are immutable. They cannot be replayed through either webhook.

Additive migration `0048_confused_avengers.sql` creates `financial_final_weight_reconciliation_events`, a distinct receipt with a unique original event ID, fresh source/Xero hashes, original/expected full Draft snapshots, a one-time reservation/payload and exact read-back evidence. The recovery service accepts **only** an original event that is still immutable `reconciliation_required` with the recorded HTTP 404 outcome. It re-reads the current exact Deal and current exact Draft, refuses evidence drift, and cannot clear, edit or reuse the original claim.

The recovery uses a separate default-off `FINANCIAL_FINAL_WEIGHT_RECONCILIATION_ENABLED` gate and has no webhook, UI button, schedule or retry. If later individually approved, it permits one exact `POST /Invoices/<verified ID>` for the already-previewed immutable Draft and then exact full read-back; any uncertainty creates a new reconciliation hold. It is not a route to amend an Authorised, paid, allocated, voided, deleted, legacy or ambiguous document. D702928 is currently `AUTHORISED`, so it is not eligible for AP Final Weight amendment.

### 2026-10-13 final revalidation — no recovery write

After the recovery checkpoint was published, the separate gate was enabled only long enough to conduct the owner-approved final GET-only revalidation. No recovery receipt or writer execution was created. The current evidence differed materially from the prior preview:

- `INV-702915` remains an unpaid `DRAFT`, but its current source quantities/rate calculate a `SER70` Excess weight line of **$23.67 GST-exclusive**, **$2.37 GST**, **$26.04 inclusive**. The prior $207.10 / $227.81 approval was therefore not usable. The revised update was explicitly declined, and the recovery gate was returned to **off**. Its current retained Due Date is 2026-10-27.
- `INV-702934` is now `AUTHORISED`. The Draft-only recovery correctly refuses to retrieve an amendment target and no Due Date change is permitted.

Fresh exact source/Xero evidence and a new explicit approval are required before any future D702915 recovery attempt. An Authorised `INV-702934` must remain outside this Draft-only automation unless a separate, explicitly approved business process is designed.

### 2026-10-13 resumed recovery review — no write

The owner asked to resume Final Weight approval review. AP re-read the immutable records: D702915 Overweight remains the separately declined historical 404 recovery, while D702934 Underweight remains a historical 404 recovery whose prior current read showed `INV-702934` as `AUTHORISED` and therefore outside Draft-only scope. A fresh GET-only D702934 source/Xero eligibility check was attempted before presenting any amendment: source facts remained available (estimated 7 tonnes, actual 4.8 tonnes, source pickup date 2026-10-12), but Xero returned its daily-request-limit hold with a retry window of 2h 57m. No current invoice state or new exact payload could be verified, so no reconciliation gate, receipt, writer execution, Xero document or VTiger record changed.

### 2026-10-13 post-upgrade recheck — terminal historical recovery holds

After the owner reported a Xero limit upgrade, a bounded direct Accounting `GET /Invoices` probe returned HTTP 200. AP therefore cleared only its verified stale local rate-pause record; no financial configuration, policy, document, contact or CRM record changed. Fresh force-refreshed exact-number reads then established the current terminal states:

- `INV-702915` is now `ACCREC` **PAID**. Its historical Overweight recovery can never enter the Draft-only exact-resource POST path.
- `INV-702934` is `ACCREC` **AUTHORISED**. Its historical Underweight recovery likewise remains outside the Draft-only automation.

Both legacy 404 recovery claims remain immutable and the separate `FINANCIAL_FINAL_WEIGHT_RECONCILIATION_ENABLED` gate remains **false**. No reconciliation receipt, writer execution, Xero write or VTiger change was created. The current-event Final Weight routes remain live for independently eligible new Draft events only.
