# For Hire Container Control POs — AP Production Cutover

**Status:** Code-complete and tested. The approved current scope is **initial For Hire Draft POs only**; recurring extensions remain disabled until the separate Operations monthly-job handover.

This handover covers only **For Hire Container Control Purchase Orders**. It does not affect Asset acquisition, Customer Sale, recurring storage, finalisation, or other Financial Operations families.

## Implemented AP behavior

| Flow | Trigger | AP output | Key safeguards |
|---|---|---|---|
| Initial hire | Dedicated VTiger **FOR HIRE Request** branch calls AP | One new Xero **Draft Purchase Order** `H<Container Control>` | Refreshes Container Control and Vendor from VTiger; exact Xero contact/item/PO preflight; account 312; AUD; no write when held |
| Recurring hire | AP-managed monthly callback only after a later separate approval | One next consecutive Draft PO `H<CC>-2`, then `-3`, etc. | AP-owned verified predecessor only; ON HIRE/IDLE only; 30-day continuous period; HC 20 E/HC 40 E current Xero purchase rate; no catch-up, Lift fee, or JD PO |
| Dehire | Current source shows DEHIRED | No further Draft PO | Clears AP-local next-due marker; does not alter historic Xero POs |

The For Hire sender ignores financial values supplied by the webhook. It retrieves the current Container Control and assigned Vendor from VTiger and does GET-only Xero preflight before an allowed Draft attempt.

## What must remain separate

- The existing shared VTiger Container Control action supports **Asset**, **Customer Sale**, and **For Hire**. Do **not** redirect that shared action to AP.
- The legacy Operations recurring job is `forHireMonthlyPo` (UID `PtaAhkr5tHtixG7E4DTZhC`). It must be paused **only after** the dedicated FOR HIRE branch has been saved and verified.
- Operations history is never imported. The AP release is **new events only**.
- The route accepts the established VTiger body shape (`id` or `record_id`; optional event) but requires the private `x-financial-webhook-secret` header. Do not expose the secret in a VTiger note, UI, chat, or documentation.

## Exact activation sequence

1. **Publish the AP checkpoint** that contains the guarded receiver, writer, selector, and Container Hire POs workspace.
2. In VTiger, create or confirm an independent **FOR HIRE Request** workflow branch. It must run only after the Container Control acquisition is `FORHIRE`; it must not run for Asset or Customer Sale.
3. Configure that branch to POST to:

   ```text
   https://apinvmanager-dm3caxom.manus.space/api/webhooks/vtiger/container-control-for-hire
   ```

   Use the existing body format with the exact Container Control `id`/`record_id` (for example `24x901`) and the same private header authentication model as the AP storage routes.
4. Leave the shared Asset/Customer Sale action unchanged. Save and verify the new dedicated For Hire branch first.
5. For an **initial-only release**, keep Operations `forHireMonthlyPo` running and record that the AP recurring policy is disabled. Pause it only in the later recurring handover.
6. Confirm the named release: **“Activate AP For Hire initial Draft POs for new Container Control For Hire events only from `<Sydney date/time>`; the Operations initial For Hire action is paused; the Operations recurring writer remains active and AP recurring remains disabled; no existing history is migrated.”**
7. After that confirmation, set only `FINANCIAL_FOR_HIRE_AUTOMATIC_ENABLED=true` in the published AP environment and record the AP-local **initial-only** release policy with the cutover time, approver, independent VTiger branch confirmation, and initial Operations handover.
8. In the later recurring cutover, pause the **Operations `forHireMonthlyPo` job only for For Hire**, then record recurring handover approval and create one AP Heartbeat:

   ```text
   name: financial-for-hire-recurring
   endpoint: /api/scheduled/financial-writer/recurring_for_hire
   cron: 0 0 0 1 * *
   ```

   Bind its exact task UID to the AP lifecycle ledger. It has no effect until the policy, deployment flag, and enabled task all agree.
9. Send a **new** qualifying For Hire Container Control through the dedicated branch. In **Container Hire POs**, verify one initial `H<CC>` Draft receipt, contact, dates, account 312, GST, amount, and no duplicate legacy PO. Do not rely on the monthly extension until its separate handover is complete.

## Current non-live checks

- The initial receiver requires `FINANCIAL_FOR_HIRE_AUTOMATIC_ENABLED=true` and an AP-local initial-only release policy; its default remains disabled.
- No AP For Hire Heartbeat is required or permitted for the initial-only release.
- AP recurring remains disabled until the Operations monthly job handover is separately confirmed.
- The application has a top-level **Container Hire POs** administrator workspace for current-source/Xero previews and the AP-only lifecycle ledger.

## Validation completed

- TypeScript check passed.
- Focused release, receiver, recurring selector, exact payload, writer-isolation, and Xero preflight tests passed.
- Full application test/build validation is run before checkpointing this change.
