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
| Lines | Current VTiger Quote Service quantity and list price remain the financial source. An explicitly transport-named Service uses **SER9** for `SHIPPER OWN` or **SER60** for `PURCHASED`/`HIRED`; `IMPORT`/unknown values hold only when a transport line is present. AP replaces the native `from <> to <>` route template on that transport line alone. A current 20/40-foot container product uses the verified matching `20' Sale`/`40' Sale` item; an explicit 20/40-foot container-hire Service uses the verified `20' Hire`/`40' Hire` item and account 210; every non-transport line retains its exact Quote Service name. Other Quote Services remain itemless rather than receiving a guessed code. |
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
9. **Selective-line correction:** D702944 source/Xero evidence identified the prior over-application defect: its Quote contained one `20 Foot Standard Height Container - Cargoworthy Grade` product line at $2,250.00 and one `Transport - Empty & Loaded Container` line at $6,877.16, but both were rendered as SER60 transport. The corrected future-event rules select `20' Sale` for the product line, preserve its exact Quote Service description, and apply SER60 route wording only to the explicit transport line. The existing `INV-702944` remains an untouched Xero Draft pending a separate exact correction approval.
10. The selective-line release is published with the original Main Invoice new-events-only effective time retained. The independently audited policy hash is current. Public authenticated probes returned parser-safe HTTP 400 for an invalid identifier and a bounded nonexistent D-number hold with explicit `xeroWritesAttempted: 0`.
11. **Non-transport Quote-line rule:** `INV-702941` evidence confirms a `20 Foot Standard Height Container Hire per 30 days` line at $209.25 and one `Transport - Empty & Loaded Container` line at $4,251.83. Future main invoices preserve the exact Quote description and no guessed Xero item for every non-transport line, including hire; only an explicitly transport-named line receives the SER9/SER60 native route template. The published Main Invoice policy has been refreshed against this rule while preserving its original new-events-only effective time. The existing DRAFT `INV-702941` remains unchanged pending a separate exact correction approval.
12. Owner approved the exact `INV-702941` Draft correction on 16 October 2026. AP changed only the first-line description to `20 Foot Standard Height Container Hire per 30 days`; a post-write Xero read-back verified the same Draft ID/status, contact, reference, transport line, GST and totals. The immutable writer-execution receipt is `870001`.
13. **Hire-item enhancement:** a GET-only Xero item audit verified active sales items `20' Hire` (name `20 Foot Hire`) and `40' Hire` (name `40 foot hire`), both account 210/OUTPUT. Future matching 20/40-foot hire Quote Services use these codes while retaining their exact Quote description, quantity and list price. The published policy was refreshed to the Hire-item rules hash under the original 13 October 2026 new-events-only cutover. Authenticated public invalid/nonexistent-ID probes were zero-write. Existing Xero Drafts are not updated by this rule.
14. **Published evidence:** the public authenticated GET-only preview for `D702941` returned HTTP 200 with `noWrites: true` and correctly held the already-existing `INV-702941` Draft. Its fresh proposed first line was `20' Hire`, account 210, quantity 1, unit amount $209.25 and exact Quote description `20 Foot Standard Height Container Hire per 30 days`; the independent transport line remained `SER60` / account 200. The Main Invoice UI uses account-neutral wording because each line uses its verified Xero sales account.
15. **40-foot Hire verification:** the public authenticated GET-only preview for `D702929` / `Q531817` proposed `40 Foot Standard Height Container Hire per 30 days` as `40' Hire`, quantity 1, unit amount $330.75 ex GST and account 210. Its separate transport line remained `SER60` / account 200. Existing `INV-702929` is AUTHORISED, so AP held it without adoption, update or a new Xero document. The published preview table now displays an explicit **Xero item code** column, including `—` for intentionally itemless Quote lines.

## Explicit exclusions

- No authorisation, sending, payment, voiding or deletion of customer invoices.
- No automatic Warranty document, Deposit invoice or Final Weight adjustment.
- No historical migration, generic webhook intake, Xero invoice suffixing or duplicate adoption.
- No recurring schedule or Heartbeat is used for this family.

## Validation

- Migration: `0041_curly_molecule_man.sql`.
- Regression coverage: source/Quote/Service evidence, collision holds, default-off policy, protected disabled receiver and isolated writer authorisation.
- The release flag is enabled only for Main Customer Invoice automatic Draft creation. Other financial family flags and all invoice approval/send/payment/void/delete operations remain outside this release.


### 2026-10-18 — superseded Main Invoice date-term rule

The former Main Invoice date-term rule required Full Container Pickup DATE. It is retained here as audit history only and is superseded by the 19 October clarification below. The Final Weight date policy is separate and remains unchanged.

### 2026-10-19 — optional Main Invoice pickup date — published and active

The user confirmed that Full Container Pickup DATE is **not required** to create either a Main or Deposit Draft. The prepared Main Invoice v7 rule therefore uses a verified populated pickup date when available: Xero `Date` is that calendar date and `DueDate` is +2 Sydney calendar days (or +14 for normalized `ON ACCOUNT`). When the field is blank or unavailable, the Main Invoice remains eligible and uses the original Operations fallback: the current Australia/Sydney business date as Xero `Date` and **no DueDate**. A populated malformed date still holds rather than being guessed.

VTiger/Xero transport uses ISO date-only values internally, while all customer-visible application dates now display as `DD/MM/YY`. Source parsing accepts the user-requested `DD/MM/YY` and `DD/MM/YYYY` forms as well as VTiger's date-only API value. Deposit already treated its Empty Container Supply Date and Full Container Collection Date as optional; it now accepts the same Australian source-date forms and continues to omit DueDate if both optional dates are blank.

The new Main Invoice rules hash is `a6dd3a265832bb8b6113c8674eb8a7d5e0eed37f383f69f069cb372e41865d79`. After the owner published checkpoint `534d8d58`, the audited Main Invoice policy was refreshed to release key `MAIN-INV-a6dd3a265832bb8b` and this hash, retaining its original `2026-10-13T02:56:59.243Z` new-events-only cutover. An authenticated public nonexistent-Deal probe returned an exact bounded `not_found` hold, zero new ledger rows and `xeroWritesAttempted: 0`. No Xero or VTiger record changed while preparing, publishing or releasing this rule. A GET-only D702945 preview confirmed its current pickup date as `04/11/26` (Xero Date `2026-11-04`, DueDate `2026-11-06`); its only current hold is an absent Xero customer contact, for which the separately enabled contact-v2 flow would create/read-back the exact contact on an eligible released event.

### 2026-10-19 — approved D702945 contact and Main Draft

The owner approved the exact current sequence after a fresh GET-only source/Xero preflight. AP resolved the current exact Deal `D702945` to VTiger `5x490223`; it was not permitted to use the stale earlier technical reference. The source selected individual **Terry Brown** (email `symohea@gmail.com`), for whom Xero had zero exact email and name matches. One guarded Xero contact was created and independently read back as active `Terry Brown` with that email (customer-contact audit `150001`).

AP then re-read current source/contact/Xero evidence and created only `INV-702945` as an AUD `ACCREC` **DRAFT** (Main event `630001`, writer execution `1020001`). Independent Xero GET-by-ID read-back confirmed: Date `2026-11-04`; DueDate `2026-11-06`; Reference `Q532066`; Terry Brown contact; one `SER9` line `Loaded Container from ALBERTON, 4207, QLD to CAMBRIDGE, 7170, TAS`, quantity 1, `$5,180.07` net, account `200`, `OUTPUT` GST `$518.01`; subtotal `$5,180.07`; total `$5,698.08`. There was no qualifying Deposit for this Deal, so no deduction was attempted. Nothing was sent, approved, paid, voided, deleted or changed in VTiger.
