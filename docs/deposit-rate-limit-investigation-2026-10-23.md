# Deposit workflow rate-limit investigation — 23 October 2026

**Author:** Manus AI

The three reports were not the same failure. They all involved rate limiting, but they stopped at different safe points. No automatic retry or duplicate financial write occurred.

`D702950` did **not** create `INV-702950-D`. Its Deposit event `420002` stopped in preflight with HTTP 429 before any Xero writer execution or invoice ID. The event is held, so it cannot be replayed automatically.

`D702951` did create `INV-702951-D` as a Draft. Its deposit-to-main deduction did not run because the Main Invoice writer for `INV-702951` is already in `reconciliation_required` state. The earlier Main writer receipt `1530001` reported that the current Xero Draft did not match the exact retained contact, lines, account or totals. The generic deduction correctly refused to adopt or alter that uncertain Main invoice. No generic deduction receipt or Xero Main-invoice amendment exists for this Deal.

`D702952` did create `INV-702952-D` as a Draft. The deduction started after the Deposit creation but stopped at the **source-read** stage with HTTP 429 before a deduction receipt, bound payload, writer execution or amendment to `INV-702952`. The retained attempt record is `120001` and the operational alert is `2130001`.

The common issue was therefore not the Deposit calculation or line template. It was that the read-heavy financial preflights could encounter provider rate limits before the write-safe reservation stage. The original system held those events rather than creating a duplicate, which was the correct financial safety result, but it did not reduce enough of the repeated read load across the full Deposit flow.

## Corrections now prepared

The existing generic Deposit-deduction hardening remains in place: every invocation has an append-only outcome record, post-reservation faults move to reconciliation rather than remaining silently reserved, and every incomplete deduction generates an operational alert.

The new release closes the remaining read-transport gaps. All Xero financial preflight reads and customer-contact searches now use a strict GET-only route. It remains tenant-queued and cached where appropriate. It permits one retry only when Xero returns a literal 429 with a numeric `Retry-After` of five seconds or less. A missing, invalid or longer wait remains a hold. The path cannot accept a write callback, POST or PUT.

VTiger financial source reads now use a shared, short-lived read session across the Deal, Quote, service and customer reads in each Main or Deposit preflight. This removes repeated challenge/login bursts inside one workflow. A VTiger GET receives at most one retry only for a transient transport failure or a literal 429 with an explicit short retry value. The login POST is never retried.

Finally, every Xero financial Draft POST or PUT now explicitly has **no automatic gateway retry**, including Deposit creation. If a financial write response is lost or ambiguous, the writer stops for exact reconciliation rather than attempting a second document or amendment.

These changes reduce this application's rate-limit pressure and make short, explicitly instructed provider throttles recover cleanly. They cannot override Xero or VTiger limits, nor can they control calls made by other integrations. A provider 429 outside the narrow retry rule will still hold safely and surface an alert. This follows Xero's documented direction to respect the returned retry interval and treats 429 as a rate-limit response, not a successful invoice operation. [1] [2]

## Release and current-document boundaries

The hardening is validated and ready for publication, but it has not retried any historical workflow and has not changed a Xero or VTiger record. It must be published before it protects newly triggered live events.

After publication, each of the three historical cases still requires a fresh GET-only check and its own decision. `D702950` needs a new Deposit creation recovery proposal because no Deposit invoice exists. `D702951` first needs a separate read-only Main Invoice reconciliation investigation; it must not receive a generic deduction while its Main Invoice evidence is uncertain. `D702952` needs a fresh two-Draft deduction preview. If its evidence is still exact, a separate approval must specify the one Main Draft amendment before any deduction is written.

**References**

[1]: https://developer.xero.com/documentation/best-practices/api-call-efficiencies/rate-limits "Xero API rate limits"

[2]: https://developer.xero.com/documentation/api/accounting/responsecodes "Xero Accounting API response codes"
