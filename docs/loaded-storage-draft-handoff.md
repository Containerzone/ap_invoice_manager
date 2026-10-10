# VTiger → Xero Storage — lifecycle handoff

**Updated: 11 October 2026. Implementation complete for storage-only automatic initial billing, recurring billing, finalisation and controlled recovery. Deployment/cutover is not activated.** The user requested completion of these features on 11 October, extending the earlier initial-storage-only scope.

## Implemented

| Flow | Behavior | AP destination |
| --- | --- | --- |
| Initial Origin / Destination | Three new Drafts: storage-only customer ACCREC invoice, once-only JD transport PO, GD storage PO. Current Deal and referenced parties are read from VTiger. | `POST /api/webhooks/vtiger/deal-storage` |
| Monthly recurring | Next consecutive due period only, on the first Australia/Sydney calendar day. Two Drafts: customer invoice + GD storage PO; never another JD transport PO. Only complete AP activation/period receipts can drive billing. | `POST /api/scheduled/financial-writer/recurring_storage` |
| Finalisation | Current Date Out, falling back to Full Container Delivery Date, caps the last billed period. Updates only the exact stored customer/GD **DRAFT** IDs. JD is not amended. Root is finalised only after verified read-back, preventing subsequent recurrence. | `POST /api/webhooks/vtiger/deal-storage-finalise` |
| Controlled recovery | Requires its additional release gate. Can create genuinely missing exact documents for one initial/final period or the next unbilled final month, without adopting unrelated legacy records. Multi-month missing history remains held for reconciliation; no fabricated bulk catch-up. | Same finalisation route |

**UI:** Standalone administrator sidebar **VTiger → Xero Storage**, route `/storage-automation`, outside Financial Operations. It shows receiver/release status, initial/monthly/finalisation receipts, next due/final date, held reasons and read-only reference previews. The historical invoice-only test is separately identified. No public/manual Draft-write button.

### Financial rules

- Sydney business dates use `Temporal.PlainDate`; inclusive day count, no DST-hour drift.
- Initial period: month end, extended through the next month end when fewer than seven days remain, capped by delivery. Recurring periods start the day after the last verified billed day and finish at that calendar month end.
- Four supported 20/40-foot Standard/High Cube types. Weekly storage rate: **$59.09 / $86.36 ex GST** for 20/40 feet, prorated by inclusive days. Customer account **200**, storage supplier account **311**, 10% GST Exclusive, AUD; due one calendar day after invoice date.
- One-time transport: **$250.00 / $340.91 ex GST**, account **310**, existing Xero items **JD 20 / JD 40** with native purchase descriptions. These item choices were approved by the owner; no Xero item was changed.
- Per-Deal suffix reservation is unique; deposit suffix **D** is skipped. First activation uses `INV-<digits>-A`, `JD<digits>`, `GD<digits>`. Later periods/events use the reserved suffix on invoice/PO numbers. No suffix is chosen to bypass an occupied reference.

## Release behavior

`financial-automation.loaded-storage-release` is the AP-local standing storage policy. Once separately approved and enabled, it replaces per-Deal manual approvals for qualifying storage events only. It contains a versioned rules hash, release key, approver/time, effective time, initial/recurring/finalisation handover confirmations and a separate recovery permission.

Deployment gate **`FINANCIAL_STORAGE_AUTOMATIC_ENABLED` is off**. Pilot gate `FINANCIAL_INITIAL_STORAGE_ENABLED`, broad `FINANCIAL_LIVE_WRITES_ENABLED`, and VTiger post-success flag remain off. No approval/enable operation was invoked during implementation. The administrator preparation API can save only a disabled policy; server-only approval and schedule-binding helpers are available for the later confirmed cutover. Neither creates or runs a managed schedule.

Every request rechecks persisted release authority and the exact preflighted payload hash. All storage payloads are restricted to one AUD/GST-Exclusive Draft invoice/PO, accounts 200/310/311. Updates require finalisation and an immutable target ID. Unrelated financial families remain locked.

Durable per-location claims prevent monthly/finalisation races. Per-document receipts support partial retries; a timeout can be reconciled only against an exact matching AP execution attempt/payload and fresh Xero Draft content. Existing unrelated documents are held, not imported or duplicated. Changed source facts, changed closed Date Out, non-Draft targets, overlapping periods, missing history and ambiguous references hold for reconciliation.

After verified Xero success, notes and the required **Finalise Storage Invoice** task (stages 4/5/6) are queued independently. The task retains ACCOUNTS type, High priority, Not Started status and Date Out due/start date. VTiger writing requires its own enabled/verified mapping and AP assigned-user ID. Failed/pending follow-up never repeats Xero billing; the daily storage callback retries storage-only follow-ups when separately enabled.

## Exact live cutover — not performed

1. **Publish the saved AP checkpoint**, then verify the production storage page and both authenticated receivers. Keep write gates off during this verification; use read-only previews, not legacy Deal event probes.
2. In Operations/VTiger, retain rollback configuration and pause/drain only these storage writers:
   - Shared Origin/Destination action → `https://supplycrm-7kuu33x8.manus.space/api/webhooks/vtiger-storage`.
   - Monthly storage Heartbeat **`4rB9Yofib8MRLRbijj4z9k`**, name **`storage-monthly-billing`**, callback `/api/scheduled/storageMonthlyBilling`.
   - Finalisation action → `https://supplycrm-7kuu33x8.manus.space/api/webhooks/vtiger-finalise-storage` — preserve the Accounts task behavior by verifying AP mapping or retaining an agreed task-only workflow.
3. Point the matching VTiger actions to the published AP URLs with the private header and contracts below. Confirm only AP owns the financial actions. Do not pause unrelated Operations automations, storage planning import, payment sync, underwriting or hire-end initialisation.
4. Obtain the exact **storage-only standing-release/cutover approval**, including effective time, rates/GST/accounts, create/update/recovery scope, handovers and VTiger post-success actions. Persist the approved policy and arm only `FINANCIAL_STORAGE_AUTOMATIC_ENABLED`; broad financial writing/shadow settings stay unchanged.
5. After publication and approval, create/bind the AP monthly Heartbeat under its **returned task UID** with cron **`0 5 13 * * *` UTC** and callback `/api/scheduled/financial-writer/recurring_storage`. The callback checks the Sydney first day, processes bounded batches and asks managed retry when more current due roots remain. No in-process timers. No storage/financial Heartbeat currently exists.
6. Verify the next qualifying event’s exact Draft IDs/contact/lines/GST and the storage tracker, then recurrence/finalisation and the Accounts task. Existing-document reference checks are sufficient to inspect the rules, but are not evidence that a new automated event was delivered. Do not generate duplicate documents for testing.

**Rollback:** disarm only AP storage, stop its managed task, reconcile AP-created/updated Drafts by exact IDs, then restore the retained legacy storage actions/task. Do not delete Drafts or resume both writers concurrently.

### VTiger contracts

Header on both: `X-Financial-Webhook-Secret: <private AP-managed value>`; `Content-Type: application/json`. Never include the secret in a URL, report, UI screenshot or log.

Initial:

```json
{"record_id":"5x123456","event":"deal.storage-stage-changed"}
```

Finalisation:

```json
{"record_id":"5x123456","event":"deal.storage-finalised","storageLocation":"destination"}
```

Production base: `https://apinvmanager-dm3caxom.manus.space`. Authentication rejects missing/invalid headers; source financial values in an incoming payload are not trusted.

## Verified VTiger mapping

| Fact | API mapping |
| --- | --- |
| Deal ID / business number | `Potentials.id` / `potential_no` |
| Loaded stages | `sales_stage`: `4 STORAGE at ORIGIN`, `11 STORAGE at DEST` |
| Matching storage choice | `cf_potentials_storagerequired`: `Yes at Origin`, `Yes at Destination` |
| Container / type | `potentialname` / `cf_potentials_containertype` |
| Date In / Date Out / delivery fallback | `cf_potentials_datein` / `cf_potentials_dateout` / `cf_potentials_fullcontainerdeliverydate` |
| Organisation / contact | `related_to` → Accounts; fallback `contact_id` → Contacts |
| Origin / Destination driver | `cf_potentials_contractorc2` / `cf_potentials_fullcontainerdeliveryv` → Vendors |
| Note | `ModComments.related_to`, `commentcontent`, `assigned_user_id` |
| Task | Calendar verified fields plus `tasktype=ACCOUNTS`, `taskstatus=Not Started`, `taskpriority=High`, `date_start` |

Only exact referenced records and authenticated metadata were read. Finalisation permits a later sales stage while still requiring the matching storage facts; source changes must not be inferred from old screenshots.

## D702885 reference test — historical, not imported

On 1 October the owner approved exactly one new ACCREC Draft `INV-702885-A` to **Wez Jenkins**, storage 5–9 October, $42.21 ex GST + $4.22 GST = **$46.43**, dated 5 October, due 6 October. Read-back verified Xero ID **`64a83cc1-437c-4495-8186-d33b5df439de`**; AP writer execution #1 succeeded. Original invoice **`50162b52-5761-42da-8f3f-68aeba4d7475`** remained DELETED; legacy `JD702885` and `GD702885` POs were not edited. That was an invoice-only create, not three-document webhook or monthly/finalisation execution.

On the current **11 October Sydney** GET-only source refresh, D702885 is now at **`16 REVIEW REQUEST`**, Storage Required **`NO`**, Date In **5 October**, Date Out blank, Full Container Delivery Date **6 October**. Its current finalisation preview correctly holds rather than inventing storage eligibility or modifying the source. Fixture tests retain the earlier five-day $42.21 calculation as a historical rule reference. No need to create another test Deal merely to inspect the arithmetic.

## Validation / impact

- Additive AP schema migration **0036** applied; original uniqueness constraints retained. No history import, source edit or test data inserted.
- Automated coverage includes Sydney dates/month edges, no recurring JD, exact contact/payload/ID read-back, non-Draft/ambiguity holds, standing-release isolation, disabled schedules, cron auth, changed-source holds, locks, partial/recovery/idempotency, final-month-only recovery, Accounts task preservation and reference-only previews.
- **TypeScript passed; 67 test files / 411 tests passed; production build and diff checks passed.** Unauthenticated local finalisation receiver returns **401**. Browser-authenticated visual validation remains dependent on an administrator sign-in; tests do not establish source webhook delivery.
- This implementation run made **no new Xero financial write, VTiger record/workflow update, Operations/Make modification or schedule state change**. Three existing AP mailbox/monitoring Heartbeats were inspected read-only; no financial task was created/enabled. The previous specifically approved invoice-only test is not reversed or extended.
