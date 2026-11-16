# Manual / Operations For Hire PO handover

## Current repair and activation boundary — 15/11/26

The manual-handover feature is implemented, tested and independently reviewed to support **an AP-created initial PO followed by a manually created extension**, including the legacy `-1` first-extension convention. This is a separate coverage-opening record, not a fabricated AP creation receipt. Its corrected mixed-history controls were verified present in the published application on 16/11/26. The new future-only rollout below requires its own publication. Initial For Hire remains independent; recurring creation and enrollment are not activated by code preparation.

The owner has confirmed manual recurring creation has stopped for C1920 and wants future automatic POs. Its actual selected manual PO is **HC1920-1**, not the unsuffixed HC1920. Neither historical PO may be recreated, amended, authorised, sent, paid, voided, deleted or relabelled.

## Verified C1920 evidence and outstanding facts

| Evidence | Verified result |
|---|---|
| Current Container Control | C1920 / SCFU3202120 / FOR HIRE / ON HIRE |
| Current VTiger type and supplier | 20 Foot Standard; SCF Containers |
| Existing AP initial receipt | Event 120001, HC1920, period 16/10/26–15/11/26, next-due marker 16/11/26 |
| Selected existing manual PO | HC1920-1, immutable ID 16f474a3-f49d-4742-a4ea-bd3918471c81, BILLED, AUD |
| Historical PO supplier | SCF Container Solutions, active ContactID 27f1d264-3419-4c57-b022-2c39882eaa6c |
| Current exact-name supplier match | SCF Containers is a different Xero ContactID, 30e877ea-530a-415c-a3ec-1b520ff2b464 |
| Manual PO coverage | **Unknown: its native description contains no hire start/end dates.** Its 10/11/26 issue date is not a coverage date. |
| Historical rental/fees | Hire 20HC, quantity 1, $139.50 net; $35 lift-on; $35 prepaid dehire provision; total $230.45 incl. GST |
| Historical type wording | Side-opening/high-cube wording differs from current VTiger's 20 Foot Standard; retain it untouched |
| Owner manual-stop confirmation | Given on 15/11/26; do not repeatedly request it |

Accounts must supply the last hire date already covered by HC1920-1 and confirm no later period already exists. The future supplier must also be resolved: the two SCF contact records must never be treated as a spelling-only match or silently substituted.

The prior read-only HC1920-2 illustration covering 16/11/26–15/12/26 was based only on the AP initial receipt and **is not an approved or current cutover proposal**. No local preview receipt or Xero PO was created by that illustration. The correct next HC1920-2 starts **one day after the verified/explicitly attested HC1920-1 covered-through date**, not automatically on 16/11/26.

## Accounts workflow after publication and enrollment approval

Open **Financial Automations → Container Hire POs → Manual / Operations For Hire handover**.

Enter the exact C-number, latest manual PO (including a canonical suffix such as HC1920-1), covered-through date and effective-from date. Dates accept DD/MM/YY, DD/MM/YYYY or strict ISO; Australian slash dates are never read as US dates.

Accounts makes **three separate confirmations**: this is the latest manual coverage, no later/overlapping period already exists, and the entered covered-through date is actually the last hire date paid/billed under that selected PO. A fourth, separate acknowledgement records stopped manual/Operations recurring creation. Changing text inputs clears all confirmations; changing a confirmation invalidates a previous preview.

Preview re-resolves the current Container Control and Vendor, checks the selected PO by number and immutable ID, active exact supplier identity, AUD/status, account/GST, historical line provenance and exact next-number collision, then reads the current purchase-side daily rate. Native coverage remains strictly parsed when present. Recognized legacy lump sums with no date tokens require explicit Accounts coverage confirmation and separately bound historical-line provenance; missing dates never become an inferred period from issue date, price or quantity. Malformed or conflicting dates cannot be overridden by an attestation.

Approval is exact-current and AP metadata only. A known earlier AP receipt is allowed only through its immutable anchor, with unchanged control, event, period, document/execution IDs and proposal hash. Reserved, uncertain or later competing AP history blocks enrollment. No existing AP receipt body/status is replaced and no historical manual PO is marked AP-created.

Enrollment does not enable the writer or create a scheduler. Recurring activation requires a separately approved exact-control scope and one published managed daily Heartbeat. Initially release only the reviewed pilot container; do not activate every due AP container merely because C1920's manual creation has stopped.

## Future automated periods and numbering

The first future period starts **covered-through +1 day** and ends start +29 days: 30 days exactly. It uses quantity 30, `HC 20 E` or `HC 40 E`, the current Xero purchase-side daily rate, account 312, INPUT GST and AUD Draft-only status. The future description is:

`<container number>, <exact current container type> Extended Hire @ $<daily rate> per day from <DD/MM/YY> to <DD/MM/YY>`

Legacy `HC1920-1` is a first extension, not an initial PO. Its next number is `HC1920-2`, then -3. Numbering convention is explicit and bound to the handover. Existing AP default numbering and issued document numbers remain unchanged; a collision in any status holds rather than skipping a suffix.

There are no recurring lift/dehire provision fees, transport/JD POs, skipped periods, bulk historical catch-up or old-PO amendments. Only current FOR HIRE / ON HIRE or IDLE controls can extend. DEHIRED stops future extensions; missing/ambiguous/changed evidence holds.

## Scheduling, immutability and races

A pending mixed opening excludes its old AP due root through a separate overlay, including after enrollment-gate rollback. Do not clear or move the AP initial receipt's next-due marker just to enroll it. Normal direct execution/claims and final transport guards must observe the same exclusion. The selected old AP anchor and manual opening are transactionally/CAS bound so stale concurrent work cannot race an approved opening.

Enrollment now rejects any AP-local owner of the exact next PO number before saving an immutable opening, including an old nonwriting preview for a different period. Nothing is deleted, superseded or retargeted. Ordinary preview persistence uses the same control/opening lock order and cannot insert stale normal coverage after an opening is approved.

Ordinary initial and recurring claims bind the caller's exact source/rules/proposal/preflight hashes, control, period and number. Payload authorization requires that claimed snapshot, token and canonical body; a concurrent refreshed preview cannot authorize an older callback's supplier/rate/body. Before transport, ordinary source and forced-refresh supplier/item/rate evidence are reconstructed and the reservation is checked again. Manual first-period transport retains its separate exact-current opening proof.

The first future Draft requires exclusive opening/event claims plus fresh source/manual evidence and exact current-rate wire-body verification. Only verified success retires the old anchor's scheduling marker and completes the opening. Later periods follow the genuinely AP-created successor, never the old initial receipt. Uncertain writes keep reconciliation locks and are never blindly retried.

The daily scheduler checks container-specific due dates, not daily PO creation. It uses authenticated task-owned cursors, independent AP/manual queues, a ten-candidate bound and continuation beyond held candidates. The exact released-control scope is enforced before selection limits, at direct execution and immediately before transport. Initial For Hire approval/time and unrelated financial families remain unchanged.

## Xero history limitation

PurchaseOrders supports exact number/ID reads but no reliably documented container-prefix/Reference filter. The app does not scan the tenant ledger or declare an empty partial list complete. API series evidence remains `complete:false`; complete latest/no-future-coverage review remains Accounts' responsibility. A known higher-number collision or overlapping supplied period still holds regardless of confirmations.

## Validation and state

The final corrected implementation passed **19 focused files / 767 tests** and **162 application files / 2,504 tests** in a network-isolated namespace, with configured database access removed and opt-in live tests plus the unrelated Microsoft Graph credential network test excluded. TypeScript, Vite/esbuild production build and diff checks passed. Existing CSS import-order and chunk-size warnings are unchanged. Browser verification found the three separate coverage confirmations, explicit optional original lump-sum line/amount review, empty records and disabled enrollment controls. Independent final targeted review returned **ALL CLEAR** for both reported concurrency blockers; the corrected checkpoint is ready for publication, not financial activation.

One preliminary unrestricted test invocation contacted Microsoft Graph for token/inbox-metadata checks through an existing credential test. It made no email or financial-document write; do not label that invocation offline. Final regression was rerun with network access blocked and that test excluded.

Final read-only state: initial writer true; recurring policy/runtime false; exact-control scope empty; manual enrollment false; 0 handovers and 0 audits; no For Hire Heartbeat; AP initial event 120001 remains drafts_created with next due 16/11/26 and writer 630001. The additive 0057 tables were created for the original feature; this repair stores versioned plans/anchors in existing JSON and does not require historical-row migration. No financial write, enrollment, schedule action or live gate/policy change occurred. Accounts coverage/supplier clarification, publication, exact enrollment and recurring activation remain pending.

## New AP initial-hire chains — future-only rollout, 16/11/26

The owner approved preparing the future-only recurring rollout while Accounts reviews the historical workbook. This is separate from the C1920 manual-coverage opening above. The 17 active historical controls in the 16/11/26 Accounts extract stay excluded from automatic future eligibility: C1183, C1805, C1869, C1873, C1876, C1878, C1880, C1893, C1894, C1896, C1904, C1911, C1912, C1920, C1922, C1925 and C1927. Their exact VTiger webservice IDs are retained in the prepared exclusion evidence, not guessed from their C-numbers. The earlier note's human-readable C-number list was corrected to match that existing, unchanged extract; no exclusion policy had been activated.

Future-only eligibility requires a newly inserted initial event from the authenticated, independent AP For Hire webhook; a successful exact guarded Draft writer; and an immutable initial-origin receipt. The additive migration 0058 creates `financial_for_hire_initial_provenance` only. It contains no historical imports or backfills. Direct administrative initial calls, old previews, duplicate callbacks, uncertain writes and existing manual/AP histories cannot mint future-origin evidence.

The recurring v4 policy preserves the original initial release key, rules, approver and cutover, including its literal Sydney-offset timestamp. It introduces disabled-by-default future-initial eligibility, an explicit UTC cutover and the 17 exclusions. Named, individually reviewed manual handovers remain a separate authority; future-only scope cannot activate manual enrollment or bypass its coverage/supplier checks.

Every future successor must have a bounded, exact verified AP ancestor chain, matching successful writer/body receipts, consecutive dates and the existing numbering convention. Eligibility is checked before due selection/execution, claim, binding and final transport. Current supplier/rate checks remain mandatory. Revoked policy, altered proof, uncertainty, dehire or a manual opening overlay holds rather than adopting another origin.

Daily checks create one 30-day Draft only when its exact next period is due. A fully expired next period is held, never rolled forward or caught up; invalid business dates also fail closed. New initial commercial rules, monthly prices, existing PO numbering, item codes and unrelated financial families are unchanged. The new admin panel explicitly distinguishes prepared future eligibility from active recurring billing.

The owner freshly confirmed at 22:03:15 Sydney on 16/11/26 that the separate Operations `forHireMonthlyPo` job is paused. This is owner-confirmed current handoff evidence, not a new independent Operations API read; do not request the same confirmation again. Publication remains required before any recurring policy or managed daily schedule action. At 22:04 Sydney the published site still identified the older 38eeef20 build and did not show the new future-only panel. The cutoff will be recorded during the actual approved activation after publication, not backdated to an earlier invoice illustration. Because AP receipt creation timestamps have database-second precision, use an explicit whole-second UTC cutoff at the start of the activation sequence, then confirm it is reached before policy release.

Current read-only evidence confirms 0 provenance rows, 0 manual handovers, 0 handover audits and 0 For Hire schedule rows. Recurring/future eligibility and manual enrollment remain off. No Xero/VTiger/customer/document write, historical receipt change, policy release or schedule creation has occurred as part of this implementation.

The final Xero callback rechecks the exact current policy, reservation, preview/body and future-chain proof or manual claim **inside the tenant FIFO immediately before POST**, after authentication and queue waits. This guard is DB-only; it does not nest queued Xero source/rate GETs. A scope revocation, replacement/reconciled claim or period expiry while queued prevents submission. Initial commercial/date behavior and other financial families are preserved.

Delivery validation passed **165 application files / 2,671 tests** with outbound connections blocked and live/Graph credential tests excluded, plus TypeScript, production build and diff checks. The queued-transport suite passed 47 cases using the real FIFO and mocked HTTP; final independent targeted review returned **ALL CLEAR**, with 84 transport/date boundary cases passed. Browser verification shows future scope disabled, cutoff not approved and no automatic enrollment. Pure construction against the actual stored initial policy passed with all 17 exclusions and the literal Sydney-offset initial authority unchanged. Publication and the actual managed daily cutover remain pending; the owner's current legacy pause confirmation is complete. No early test PO or historical replay was performed.
