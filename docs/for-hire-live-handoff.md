# For Hire Container Control POs — AP Production Cutover

## Current state — 15/11/26

**Initial For Hire Draft POs are active for new events only. Recurring supplier POs remain disabled.** Step 4 has been implemented and tested as **daily checks, container-specific 30-day billing**; it has not activated a scheduler or completed the recurring Operations handover.

The owner confirmed that Asset acquisition and Customer Sale workflows are separate, that the dedicated initial For Hire workflow works, and that the initial test PO is HC1929. AP's exact read-only receipt confirms Container Control C1929, initial event 180001, writer 3150001 succeeded, Xero creation status DRAFT, and PO HC1929. Its HC 40 line is `40' Container Hire from 13/11/26 to 13/12/26`; its next billing date is 14/12/26. No live document was created or changed by the scheduling repair.

This handover covers only For Hire Container Control purchase orders. Asset, Customer Sale, storage, customer Extra Hire invoices and other financial families remain outside this change.

## Implemented behavior

| Flow | Trigger | Output and boundaries |
|---|---|---|
| Initial hire | Dedicated FOR HIRE VTiger Request branch | One AUD GST-exclusive Draft PO `H<C-number>` using HC 20 / HC 40, account 312, INPUT GST; optional initial Lift & Booking Fees. |
| Recurring hire | Future, separately activated managed daily callback | Select only verified AP-created predecessors whose next billing date is due on/before the current Australia/Sydney business date. Create one next consecutive Draft `H<C-number>-2`, then -3, etc., for its next 30-day period. This is not daily PO creation. |
| Dehire | Current Container Control is DEHIRED | No extension PO; clear only the AP next-due marker. Do not alter historical Xero POs. |

Every allowed attempt refreshes the exact Container Control and assigned Vendor and revalidates current Xero supplier, item, rate, collision and Draft evidence. Only ON HIRE / IDLE controls can extend. Historical Operations history is never inferred or imported; expired periods and uncertain claims remain held. No authorisation, sending, payment, voiding or deletion is allowed.

### Items and exact descriptions

- Initial 20/40-foot items: `HC 20` / `HC 40`.
- Initial description: `<20/40>' Container Hire from <collection DD/MM/YY> to <collection +30 days DD/MM/YY>`.
- Recurring 20/40-foot items: `HC 20 E` / `HC 40 E`, quantity 30, current Xero purchase-side daily rate, account 312 and INPUT GST.
- Recurring description: `<container number>, <exact container type> Extended Hire @ $<rate> per day from <DD/MM/YY> to <DD/MM/YY>`.
- A recurring period starts one day after the verified prior end and ends 29 days after its start. No recurring Lift fee or JD transport PO is added.

For HC1929, the next possible recurring Draft is **HC1929-2**, dated **14/12/26**, covering **14/12/26–12/01/27**. After its verified completion, the next due date becomes **13/01/27**. These are tested expected future periods, not a claim that either recurring PO exists.

## Daily schedule preparation — not activation

```text
Name: financial-for-hire-recurring
Endpoint: /api/scheduled/financial-writer/recurring_for_hire
Cron: 0 5 20 * * *
Platform timezone: UTC
Business-date timezone: Australia/Sydney
Check time: daily 06:05 AEST / 07:05 AEDT (20:05 UTC)
```

The managed platform requires UTC, six-field cron. The prepared morning time maps to exactly one Sydney calendar date in both standard and daylight-saving time. The same constant is used by readiness, financial default settings and the future approved schedule binding. There is no in-process timer.

The callback looks up the authenticated cron task UID, checks the enabled local schedule, rejects a stale first-of-month/mismatched cadence, and checks the separate approved recurring release. A bounded batch handles up to ten due AP predecessors. An AP-owned traversal cursor is stored under the authenticated task's audit JSON; the request body cannot set a cursor, task UID or business date. A full batch requests platform-managed continuation only when unvisited due roots remain, even if the visited roots were held. Held receipts keep their original dates and claims; their presence cannot permanently starve later eligible containers.

Traversal progress is monotonic within the Sydney business date and never rewinds concurrent progress. Completed traversals reset on the next Sydney date. An unfinished traversal carries forward when the finite platform retry allowance is exhausted, rather than restarting at the same held predecessors every day. The ten-root callback bound and platform retry limit remain in force; large due pools can take multiple callbacks or days to finish a traversal. Capacity, remaining due roots and held results must therefore be monitored during cutover. No historical catch-up, financial write retry, duplicate scheduler or in-process polling loop was introduced.

The rate-only preview now receives the same business-date input as the final preview. Tests no longer depend on today's wall clock for an old October fixture. No commercial period, item, amount, initial-release rule or financial-authority hash was broadened.

The For Hire preview ledger now also protects claimed and terminal receipts atomically: a duplicate insert is a no-op, and preview refresh updates only currently unclaimed preview/hold/dehire rows. A stale concurrent callback cannot reset a reserved, completed or reconciliation-required receipt, overwrite its writer/Xero evidence, or claim it again after a rate change. Deterministic interleaving tests cover reserved, completed and uncertain outcomes; no live receipt was modified by this repair.

## Remaining activation order

1. Publish the checkpoint containing this daily-due repair before any scheduler action. Verify the published readiness and disabled recurring state without creating a financial document.
2. Complete **step 5: coverage for existing hires**. Identify controls with only Operations-created PO history and agree their coverage before pausing the entire legacy monthly job. Do not import history or create catch-up POs under this repair.
3. After that coverage plan and release approval, pause only Operations `forHireMonthlyPo` (known UID `PtaAhkr5tHtixG7E4DTZhC`). Verify its actual remote state; this repair neither inspected nor paused that job.
4. Record explicit recurring handover approval and Sydney effective time while preserving the existing initial For Hire scope. Do not reset initial cutover or enable another family.
5. Create exactly one managed daily Heartbeat using the above cron/endpoint after publication. Bind its returned task UID to the AP schedule ledger and the approved recurring release. Do not bind an invented UID or create another scheduler alongside Operations.
6. Verify the published runtime gate, recurring policy, task UID and enabled daily cadence agree. Current recurring policy and handover are false and no AP For Hire Heartbeat is registered.
7. Verify the first genuinely due, separately approved Draft through full current source/Xero read-back. Do not bring HC1929 forward from 14/12/26 just to test.

The initial receiver remains `POST /api/webhooks/vtiger/container-control-for-hire`, with the established private JSON `id` / `secret` body or supported financial secret header. It accepts one exact webservice ID or an exactly resolved C-number and does not trust financial body values. No secret belongs in this handover.

## Validation and authority boundary

- Focused For Hire/recurring suites: **10 files / 105 tests passed**, including ten held predecessors followed by an eligible due container, task-owned cursor spoofing protection, monotonic audit-only updates, continuation past the daily managed retry limit and stale-preview races against reserved/completed/uncertain receipts.
- Full offline application regression: **151 files / 1,824 tests passed**, excluding opt-in live tests and the unrelated Microsoft Graph credential network check.
- TypeScript, production build and diff checks passed.
- Read-only application state check confirmed initial For Hire and customer Extra Hire writers remain enabled; recurring policy, recurring Operations handover and Heartbeat remain disabled/unregistered; HC1929 event 180001 / writer 3150001 / next due 14/12/26 are unchanged.
- No Xero/VTiger document or source write, schema migration, live policy or gate update, scheduler create/enable, Operations pause or historical import occurred. Publication and recurring activation are separate pending steps.
