# Main Customer Invoice — AP Migration Handover

**Status:** Implemented and **disabled** in AP Management as at 11 October 2026.

## What AP now owns when separately released

| Item | AP rule |
|---|---|
| Source trigger | Dedicated VTiger Main Customer Invoice action, carrying one exact Deal webservice ID or legacy `D<number>` potential number only. |
| Current source facts | AP re-reads the Deal, linked Quote, current organisation/contact and every current Quote Service line. Body customer/amount/line values are ignored. |
| Xero document | One `ACCREC` **Draft** only. |
| Reference | `INV-<Deal number without D>`; for example `D702877` → `INV-702877`. |
| Customer | Exact current Deal/Quote organisation, otherwise exact current contact; Xero contact must resolve uniquely. |
| Lines | Current VTiger Service description, Quote quantity and Quote list price; account **200**, AUD, GST exclusive. |
| Collision | Any existing Xero invoice with the exact `INV-…` number is held. AP will not suffix, adopt, amend or delete it. |
| Recovery | An ambiguous Xero create/read-back result is marked reconciliation-required. It is never blindly retried. |

## Current AP endpoints and UI

- **VTiger receiver:** `POST /api/webhooks/vtiger/main-customer-invoice`
- **VTiger authentication:** either the existing AP `x-financial-webhook-secret` header or the established JSON `secret` field. The receiver compares it in constant time and never returns, logs or persists it.
- **Legacy VTiger body:** `id` can be the Deal webservice ID or the legacy `potential_no` D-number. Optional `dryRun`, customer, amount, Quote or line fields are ignored; AP re-reads the current source.
- **Administrator workspace:** **Main Customer Invoices** in the AP sidebar.
- **Current evidence preview:** exact `D<Deal>` or `5x…` lookup. It performs VTiger/Xero GET-only checks and cannot create a document.

## Conditions required before live release

1. Publish the AP checkpoint containing this receiver and confirm the public URL returns `401` without the private header.
2. In VTiger, create or edit **one dedicated Main Customer Invoice branch** only. It may use the established JSON body (`id`, `secret`, optional `dryRun`) or the existing private header; do not reuse a generic Deal action.
3. Pause the legacy **Operations Main Customer Invoice** writer for **new** events only. Do not change Warranty, Deposit, Final Weight, Asset, Customer Sale, For Hire or Storage actions as part of this handover.
4. State the effective Sydney cutover time and approve **new events only** in the current conversation. Existing Deals/invoices remain reconciliation work; AP does not adopt them.
5. Record the AP-local release policy with both handovers marked complete, then enable only `FINANCIAL_MAIN_CUSTOMER_INVOICE_AUTOMATIC_ENABLED=true`.
6. Send one new qualified event and verify the single exact Xero Draft invoice in **Main Customer Invoices**: `INV-…`, customer, Quote reference, Services, account 200, GST, total and Draft read-back.

## Explicit exclusions

- No authorisation, sending, payment, voiding or deletion of customer invoices.
- No automatic Warranty document, Deposit invoice or Final Weight adjustment.
- No historical migration, generic webhook intake, Xero invoice suffixing or duplicate adoption.
- No recurring schedule or Heartbeat is used for this family.

## Validation

- Migration: `0041_curly_molecule_man.sql`.
- Regression coverage: source/Quote/Service evidence, collision holds, default-off policy, protected disabled receiver and isolated writer authorisation.
- The release flag remains unset/false; this document records preparation only.
