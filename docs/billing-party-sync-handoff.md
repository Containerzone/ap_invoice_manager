# Latest Deal billing-party synchronization

## Owner-requested behavior

At a qualifying Deposit creation trigger or the existing main-finalisation (Final Weight Overweight/Underweight) trigger, read the current VTiger Deal billing party again. A usable organisation on that Deal takes priority; otherwise use its current contact. Do not take billing names, emails, amounts or Xero ContactIDs from the webhook body or an earlier Main Invoice reservation.

Use the existing customer-contact v2 protocol: organisations are exact-name-first, with email evidence; individuals are email-first with name fallback. A missing valid identity enters the separately approved contact creation/read-back workflow. Ambiguous/inactive matches remain held. An organisation must not be replaced with a person simply because they share an email address.

When the current billing party differs, a separate billing-sync operation may replace only the ContactID of the exact AP-owned `INV-<Deal digits>` ACCREC DRAFT in Xero. It must not rename a shared Xero contact. The existing invoice item codes, Quote descriptions, line IDs, quantities, prices, discounts, tracking, accounts, GST, currency, totals, issue/due dates and reference must be preserved and verified after the update. It cannot create a main invoice, authorize, send, pay, void/delete or update VTiger.

## Event ordering

The Deposit receiver first checks its normal source eligibility, cutover and prior reservation. Current customer resolution occurs before a new Deposit claim. Where the independent billing-sync policy is active, synchronize the main Draft first and then repeat the full Deposit source/contact/item/collision preflight. A further billing identity change must hold before the Deposit claim. The Deposit writer still creates only the Deposit invoice; deductions and billing changes are independent audited actions.

Final Weight first checks its existing eligibility, new-events-only cutover and exclusive document claim. Only an eligible unclaimed Draft can enter billing synchronization. Repeat the complete current full-Draft preflight and current billing-name/email resolution afterwards, so the weight/date amendment preserves the newly verified ContactID. A further party change stops before amendment reservation. This does not relax Final Weight's non-Draft or historical recovery rules.

No additional VTiger URL, webhook body field or monthly schedule is required. Existing canonical `id`/`secret` Deposit and Overweight/Underweight routes are retained.

## Collision and reconciliation policy

The Deposit final pre-transport contact validation must use the same current v2-resolved ContactID as its immutable reservation. It must not independently switch back to a name-only lookup after an email match. The stable SHA-256 helper already canonicalizes object keys; key order is not the cause of the previously observed D702941 incident.

Fresh evidence is obtained before reservation. Changed source/contact identity or actual changed Xero document/configuration after reservation remains held. Submitted, uncertain or read-back-failed writes are never blindly replayed; original reservations and audit evidence are not deleted or reset. This implementation does not recover D702941's existing held Deposit event.

A later legitimate billing change can obtain a new immutable transition only after the preceding ContactID update has been read-back verified. For example, Deposit can update party A to party B, and a later qualifying finalisation can update party B to party C. Concurrent, submitted, held and uncertain transitions cannot be reopened or superseded automatically.

Cutover and exact-document collision holds take precedence over a missing-contact suggestion. Neither a `would_create` plan nor a recently edited customer record can make a historical or colliding Deposit eligible for a contact or financial write.

## Release boundary

Billing sync is independently default-off under `FINANCIAL_BILLING_PARTY_SYNC_ENABLED`, the current audited rules policy and active customer-contact v2 gates. Runtime gate, reviewed audit migration and policy must all be ready before release. Current financial family gates, cutovers and legacy handovers are retained; no broad all-family write permission is added.

The existing Financial Automations Deposit and Final Weight tabs expose admin-only readiness, a GET-only billing preview and synchronization audit. They have no browser sync/create/retry/activation mutation. Unauthenticated and staff users cannot access the new admin procedures.

## Validation and current state

The additive migration created only the three billing synchronization audit/event/lock tables. Administrator readiness and audit queries returned HTTP 200; unauthenticated readiness, audit and preview queries returned HTTP 401. The staging Deposit tab visibly exposes the read-only inspector and `Sync not activated` state, with no billing-update or activation button.

On 18 October 2026, the authenticated GET-only preview for `D702941` returned HTTP 200 with `noWrites: true`. The **current Deal** resolves to the individual `Kyle Ram 1` (shared v2 email matching, name not exact), while the AP-owned `INV-702941` remains a DRAFT billed to `Bridgeman Stainless Steel Solutions`. The preview therefore identifies a possible ContactID-only change; it does not apply it, rename the matched contact, or recover the existing Deposit claim. Billing selection deliberately does not inherit the organisation from an older Quote or main invoice.

Final validation passed: **129 test files / 1,372 tests**, with 8 opt-in live-test files / 12 tests skipped; TypeScript, production build and `git diff --check` also passed. Mocked coverage includes immutable Deposit evidence, organisation/person matching, guarded missing-contact creation, changing billing sources, repeat verified transitions, competing claims, event-token CAS, the no-POST queue revalidation boundary, transport uncertainty/no retries, and complete financial preservation read-back. An initial unrelated Microsoft token TLS reset passed on retry and the final full project run passed.

No existing Xero invoice/contact or VTiger record has been changed by this implementation task. The three new audit/event/lock tables remained empty after the read-only checks. D702941 Deposit event `180001` remains `reconciliation_required`. Billing-sync remains default-off until its independent new-events-only release is explicitly approved and verified; the current held Deposit is excluded from automatic recovery.
