# Manual / Operations For Hire PO handover

## Status — 15/11/26

Implemented and tested, but not published or activated by this implementation task. The separate manual enrollment gate is default-off; recurring release/handover remain disabled and no AP For Hire Heartbeat is registered. The existing initial For Hire workflow and other financial families are unchanged.

The owner requested that older manually created POs remain untouched and that future POs transition safely to automation. No historical Xero PO is amended, authorised, sent, paid, voided, deleted, recreated or labelled as an AP-created receipt.

## Accounts workflow after publication and enrollment approval

Open **Financial Automations → Container Hire POs → Manual / Operations For Hire handover**.

1. Enter the exact Container Control C-number, the last manual PO number (for example HC1234 or HC1234-3), its last covered date and the handover effective-from date. Dates accept DD/MM/YY, DD/MM/YYYY or strict ISO; Australian slash dates are never interpreted as US dates.
2. Review existing Xero/Operations records and make **two separate confirmations**: the selected PO is the latest manual hire coverage, and no later or overlapping hire period already exists for that container.
3. Preview. The app resolves the current Container Control and assigned Vendor; verifies the exact Xero PO by number and immutable ID, supplier identity, AUD/status, hire item, quantity and native description date range; and checks the exact next PO number and current purchase-side daily rate. This reads financial evidence but creates no PO or AP-created receipt.
4. Stop manual/Operations recurring creation for this container and acknowledge that separately. Approve the exact-current preview. The service re-reads evidence and saves only a separate, uniquely bound opening-point record and append-only audit outcome. Changing any input or either coverage confirmation invalidates the preview.
5. Activate the recurring release and one managed daily Heartbeat only through the separately approved cutover. Enrollment does not create a scheduler or enable recurring billing.

Start with one real pilot handover before enrolling the remaining active manually billed containers. Do not use C1929/HC1929 as manual history: its initial PO already has a verified AP-created receipt and it continues through the existing AP lifecycle.

## Important Xero API limitation

The documented PurchaseOrders API supports exact number/ID reads and date/status pagination, but not a reliably scoped container prefix/Reference filter. This implementation does **not** scan the wider tenant PO ledger, issue an unsupported `where` filter, or interpret an empty partial result as complete history.

Consequently API series evidence remains `complete:false` and the complete-series/overlap assertion is an **Accounts review responsibility**, not automatic Xero proof. The authenticated administrator's two literal confirmations and reviewer identity are retained in the immutable evidence hash. Known higher-number or overlapping records, if supplied by a future genuinely scoped evidence source, still hold and cannot be overridden by those confirmations. The exact selected manual PO and exact next-number collision are independently rechecked by the app.

## Future automated periods

The first AP period starts **one day after the verified manual coverage end** and covers **30 days**, ending start +29 days. It uses the next consecutive HC ordinal, quantity 30, `HC 20 E` or `HC 40 E`, current Xero purchase-side daily rate, account 312 and INPUT GST. Its description remains:

`<container number>, <exact container type> Extended Hire @ $<daily rate> per day from <DD/MM/YY> to <DD/MM/YY>`

There are no recurring Lift fees, transport/JD POs, skipped periods or historical catch-up POs. Only current FOR HIRE / ON HIRE or IDLE controls can extend; DEHIRED stops future extensions without touching older POs. Missing/changed/ambiguous source, supplier, manual coverage, rate or numbering evidence holds rather than guesses.

The opening point is exclusively reserved against the first AP event/token. Immediately before the existing Draft-only writer, the current source, retained manual PO evidence and current-rate exact wire body are revalidated. Only verified first-Draft success closes the separate opening record and creates a real AP predecessor; later periods use that normal AP-created chain. Pending, reserved, uncertain and dehired opening locks remain effective even if the enrollment feature is rolled back to disabled. A completed opening permits recurring successors, never another initial PO.

Uncertain writer/read-back results preserve reconciliation locks in both ledgers; no financial POST is blindly retried and no ledger claim is cleared. The first-period verification checks its actual Sydney due date. Daily traversal uses independent task-owned cursors for AP predecessors and manual opening points, with ten total candidates per callback, continuation beyond held candidates and monotonic audit-only progress.

## Implementation and verified boundary

- Added and applied additive migration `0057_skinny_cardiac.sql`: only `financial_for_hire_manual_handovers` and `financial_for_hire_manual_handover_audits` were created.
- Read-only state verification found **0 handovers and 0 audit rows**, manual enrollment false, recurring policy false, recurring Operations handover false and no registered AP For Hire Heartbeat.
- Focused final validation: **16 files / 451 tests passed**.
- Full offline regression: **157 files / 2,170 tests passed**; opt-in live tests and the unrelated Microsoft Graph credential network check excluded.
- TypeScript, production build and diff checks passed. Browser verification confirmed the separate confirmations, empty records and disabled enrollment controls; invalid-ID validation was tested without financial source lookup.
- No real container enrollment, financial Xero/VTiger write, policy/gate enablement, scheduler creation, Operations pause or live pilot PO was executed.

## Remaining order

Publish this checkpoint; verify published readiness with manual enrollment and recurring billing still disabled; select one active manually billed container and its exact last PO/coverage; approve enrollment enablement and the pilot opening point; verify its stored future period; finish per-container manual-job handover and separately approve/activate the recurring release and one daily Heartbeat. Check the first genuinely due Draft by independent read-back before expanding coverage.
