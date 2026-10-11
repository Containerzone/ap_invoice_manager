# Operations-to-AP For Hire Alignment

**Reviewed:** 11 October 2026  
**Source:** user-authorized referenced task `z4BCTK6qpMx1xSv13ILqTy` (Operations / Supplier Sourcing CRM history). The source artifacts were downloaded temporarily to `/tmp/operations-for-hire-reference/` for comparison only; no Operations project was opened or changed.

## Verified Operations behavior

| Concern | Verified Operations implementation | AP Management alignment |
|---|---|---|
| Initial PO reference | `H` + Container Control business number | AP uses the same rule, e.g. `C1860` → `HC1860`. |
| Initial container items | `HC 20` / `HC 40`, account `312`, quantity `1` | Matches AP. |
| Initial period | Collection Date through the literal date **30 calendar days later** | Matches AP. |
| Initial amount defaults | 20 foot `$120.00` and 40 foot `$240.00` ex GST | Matches AP, with the current source monthly-cost inclusive-GST conversion retained where populated. |
| Initial optional fee | Lift & Booking Fees is an additional initial-only line | Matches AP. |
| Recurring items | `HC 20 E` / `HC 40 E`, account `312`, quantity `30`, current Xero purchase-side rate | Matches AP. |
| Recurring period | First starts the day after the initial period; each later period starts the day after the prior period and ends 29 calendar days later | Matches AP. |
| Recurring description | Uses the **full VTiger container type**, for example `CMAU8000629, 40 Foot Standard Extended Hire @ $8.00 per day from 02/10/26 to 31/10/26` | AP updated to preserve the full current VTiger container type instead of reducing it to `20'` or `40'`. |
| Business date | Operations evaluates due dates using `Australia/Sydney` | AP uses an Australia/Sydney calendar date when no explicit test date is supplied. |
| Duplicate run protection | One reservation per VTiger Container Control and Sydney scheduled month; a retry retains the same reference | AP records one lifecycle event per Container Control, kind and billed period, and does not adopt Operations history. |

## Verified Operations artifacts

- `hirePoPeriods.ts` — period, item-code, account, rate and description rules.
- `forHireMonthlyPoLedger.ts` — recurring reservation/retry behavior.
- `0012_for_hire_monthly_po_runs.sql` — Operations monthly reservation schema.
- `previewDatedHirePurchaseOrders.ts` — read-only selector and Xero rate checks.
- `vtigerCcWebhook.test.ts` — Container Control description excludes rich-text Notes.

## Intentional AP differences that remain safer

AP does **not** import or adopt historical Operations POs. A recurring AP PO requires a verified AP-created predecessor, and an old/missed period is held rather than bulk-created. These controls prevent duplicate financial documents during a phased migration.

## External-system state

This comparison made no change to Operations, VTiger, Xero, Make, Heartbeat schedules or webhook destinations.
