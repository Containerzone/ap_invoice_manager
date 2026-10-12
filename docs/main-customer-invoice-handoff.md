# Main Customer Invoice — AP Migration Handover

**Status:** **Live for new events only.** The dedicated VTiger branch and Operations handover were recorded, the AP-local release policy is enabled, and `FINANCIAL_MAIN_CUSTOMER_INVOICE_AUTOMATIC_ENABLED=true` is published. The first approved production test completed on 12 October 2026; no historical adoption is enabled.

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

## Recorded live-release conditions

1. The AP receiver was published and verified to return `401` without a valid secret.
2. VTiger has a dedicated Main Customer Invoice branch using the established JSON body (`id`, `secret`, optional `dryRun`) and the existing Operations Main Invoice writer is paused for **new** events only.
3. The current-conversation approval, new-events-only cutover policy and `FINANCIAL_MAIN_CUSTOMER_INVOICE_AUTOMATIC_ENABLED=true` deployment setting were recorded and published.
4. First production verification: Deal `D702935` created an exact new Xero `ACCREC` **DRAFT** `INV-702935`, reference `Q531993`, for Barry Meintjes. The immutable Xero ID is `09191cf4-bdb6-4d3b-b5c8-9ca73383a358`; exact current source, Quote line, account 200, AUD, GST exclusive, totals and one-line read-back all passed. The AP ledger event and execution are both `30001` / `drafts_created`.
5. Continue to monitor the next new events in **Financial Automations → Main Customer Invoices**. Any historical, duplicate, ambiguous, non-Draft or changed-source case must remain held for reconciliation.

## Explicit exclusions

- No authorisation, sending, payment, voiding or deletion of customer invoices.
- No automatic Warranty document, Deposit invoice or Final Weight adjustment.
- No historical migration, generic webhook intake, Xero invoice suffixing or duplicate adoption.
- No recurring schedule or Heartbeat is used for this family.

## Validation

- Migration: `0041_curly_molecule_man.sql`.
- Regression coverage: source/Quote/Service evidence, collision holds, default-off policy, protected disabled receiver and isolated writer authorisation.
- The release flag is enabled only for Main Customer Invoice automatic Draft creation. Other financial family flags and all invoice approval/send/payment/void/delete operations remain outside this release.
