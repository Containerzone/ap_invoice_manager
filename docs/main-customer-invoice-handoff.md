# Main Customer Invoice — AP Migration Handover

**Status:** **Live for new events only.** The dedicated VTiger branch and Operations handover were recorded, the AP-local release policy is enabled, and `FINANCIAL_MAIN_CUSTOMER_INVOICE_AUTOMATIC_ENABLED=true` is published. The first approved production test completed on 12 October 2026; no historical adoption is enabled. The confirmed legacy VTiger Main Invoice secret is isolated with `FINANCIAL_MAIN_CUSTOMER_INVOICE_WEBHOOK_SECRET` and is deployed.

## What AP now owns when separately released

| Item | AP rule |
|---|---|
| Source trigger | Dedicated VTiger Main Customer Invoice action, carrying one exact Deal webservice ID or legacy `D<number>` potential number only. |
| Current source facts | AP re-reads the Deal, linked Quote, current organisation/contact and every current Quote Service line. Body customer/amount/line values are ignored. |
| Xero document | One `ACCREC` **Draft** only. |
| Reference | `INV-<Deal number without D>`; for example `D702877` → `INV-702877`. |
| Customer | Exact current Deal/Quote organisation, otherwise exact current contact. Main invoice execution re-reads metadata-proven current customer Email and Mobile/Phone. Exact literal full name **and** exact email must resolve to one active Xero contact (or exact name only when no source email exists). |
| Lines | Current VTiger Quote Service quantity and list price remain the financial source. Current Deal `Container Situation` selects **SER9** only for `SHIPPER OWN`, or **SER60** only for `PURCHASED`/`HIRED`; `IMPORT`/unknown values hold. AP reads the active Xero sales item and retains its native `from <> to <>` template, substituting only current Deal Origin Suburb and Destination Suburb. Both verified items are account **200**, OUTPUT GST, AUD and GST exclusive. |
| Collision | Any existing Xero invoice with the exact `INV-…` number is held. AP will not suffix, adopt, amend or delete it. |
| Recovery | An ambiguous Xero create/read-back result is marked reconciliation-required. It is never blindly retried. |
| Missing customer contact | V2 is enabled for the active Main Customer Invoice, Deposit Invoice and Extra Hire automatic paths. It re-resolves the current Deal/linked Account/Contact, uses organisation-name-first or individual-email-first rules, and records a non-secret resolution audit. Preview remains `would_create_contact` only and cannot write. Protected automatic flows require both `FINANCIAL_CUSTOMER_CONTACT_V2_ENABLED=true` and `FINANCIAL_CUSTOMER_CONTACT_AUTOMATIC_ENABLED=true`, recheck the current VTiger snapshot, create only `{Name, EmailAddress?}`, read the immutable ContactID back, then refresh full invoice preflight before a Draft. A conflict, duplicate, inactive contact, source change or uncertain POST holds and alerts; supplier fuzzy/first-token matching is never used. |

## Current AP endpoints and UI

- **VTiger receiver:** `POST /api/webhooks/vtiger/main-customer-invoice`
- **VTiger authentication:** either the existing AP `x-financial-webhook-secret` header or the established JSON `secret` field. The receiver first accepts a Main Invoice-specific secret (`FINANCIAL_MAIN_CUSTOMER_INVOICE_WEBHOOK_SECRET`) when configured, then the shared AP secret for compatibility; every comparison is constant time and no secret is returned, logged or persisted. This isolates a legacy Main Invoice secret mismatch without rotating other live families.
- **Legacy VTiger body:** `id` can be the Deal webservice ID or the legacy `potential_no` D-number. Optional `dryRun`, customer, amount, Quote or line fields are ignored; AP re-reads the current source.
- **Administrator workspace:** **Main Customer Invoices** in the AP sidebar.
- **Current evidence preview:** exact `D<Deal>` or `5x…` lookup. It performs VTiger/Xero GET-only checks and cannot create a document.

## Recorded live-release conditions

1. The AP receiver was published and verified to return `401` without a valid secret.
2. VTiger has a dedicated Main Customer Invoice branch using the established JSON body (`id`, `secret`, optional `dryRun`) and the existing Operations Main Invoice writer is paused for **new** events only.
3. The current-conversation approval, new-events-only cutover policy and `FINANCIAL_MAIN_CUSTOMER_INVOICE_AUTOMATIC_ENABLED=true` deployment setting were recorded and published.
4. First production verification: Deal `D702935` created an exact new Xero `ACCREC` **DRAFT** `INV-702935`, reference `Q531993`, for Barry Meintjes. The immutable Xero ID is `09191cf4-bdb6-4d3b-b5c8-9ca73383a358`; exact current source, Quote line, account 200, AUD, GST exclusive, totals and one-line read-back all passed. The AP ledger event and execution are both `30001` / `drafts_created`.
5. Second production verification: after a fresh GET-only preflight and exact owner approval, Deal `D702936` created one new active Xero customer Contact through v2 and one `ACCREC` **DRAFT** `INV-702936` from Quote `Q531988`. Exact read-back confirmed its immutable Xero ID, active contact binding, one line, AUD GST-exclusive **$9,506.21 subtotal + $950.62 GST = $10,456.83 total**, and `DRAFT` status. The Main Invoice ledger event `240001` is `drafts_created`; the v2 contact audit is `created`. No approval, send, payment, void, deletion or VTiger update occurred. The dual customer-contact gates are now enabled for active automatic customer-invoice routes and were verified with authenticated local and public zero-write probes using a deliberately nonexistent Deal.
6. Legacy-secret production verification: the established VTiger JSON `id`/`secret` envelope is accepted by the published receiver. A deliberately nonexistent D-number reached the bounded exact lookup and held with `xeroWritesAttempted: 0`; it did not authenticate-fail or create a document.
7. Main Invoice transport-item release: authenticated VTiger metadata proved `cf_potentials_containersituationselectone` (Container Situation), `cf_potentials_pickuplocation` (Origin Suburb) and `cf_potentials_deliverylocation` (Destination Suburb). GET-only Xero reads confirmed SER9 is an active 200/OUTPUT sales item with `Loaded Container from <> to <>`, and SER60 is an active 200/OUTPUT sales item with `Empty & Loaded Container from <> to <>`. The pending checkpoint applies this mapping only after a complete second collision/contact/item preflight.
8. Continue to monitor the next new events in **Financial Automations → Main Customer Invoices**. Any historical, duplicate, ambiguous, non-Draft or changed-source case must remain held for reconciliation.

## Explicit exclusions

- No authorisation, sending, payment, voiding or deletion of customer invoices.
- No automatic Warranty document, Deposit invoice or Final Weight adjustment.
- No historical migration, generic webhook intake, Xero invoice suffixing or duplicate adoption.
- No recurring schedule or Heartbeat is used for this family.

## Validation

- Migration: `0041_curly_molecule_man.sql`.
- Regression coverage: source/Quote/Service evidence, collision holds, default-off policy, protected disabled receiver and isolated writer authorisation.
- The release flag is enabled only for Main Customer Invoice automatic Draft creation. Other financial family flags and all invoice approval/send/payment/void/delete operations remain outside this release.
