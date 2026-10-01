# Loaded-container storage → Xero Drafts: implementation handoff

**Status (1 October 2026): the automatic VTiger stage-triggered workflow is implemented and tested but not activated. One separately authorised customer-invoice-only Xero Draft test was created and verified; the three-document webhook remains disabled.** This replaces the earlier broad storage cutover work for the initial stage-triggered workflow only. The two supplied attachments, `pasted_content_12.txt` and `pasted_content_13.txt`, contain the same specification; the owner subsequently approved using the existing size-specific JD items.

## What is prepared

- A narrow authenticated `POST /api/webhooks/vtiger/deal-storage` endpoint accepts only `{"record_id":"5x123456","event":"deal.storage-stage-changed"}` with header **`X-Financial-Webhook-Secret`**. Never place the secret in a URL, UI screenshot, or report. Missing or invalid authentication returns HTTP 401; unconfigured authentication returns 503.
- The AP handler retrieves the current VTiger **Potentials / Deal** and its bill-to organisation or fallback contact and the location-specific vendor; it ignores supplied financial facts. It requires stage `4 STORAGE at ORIGIN` or `11 STORAGE at DEST` and a matching `Storage Required` value. Wrong stages and incomplete sources are held before any Xero financial call.
- Initial period uses Sydney **calendar dates**, including both Date In and end day: month-end, extended through next month-end when fewer than seven days remain, capped by Full Container Delivery Date. `Temporal.PlainDate` avoids DST drift. Four allowed container types use $59.09/$86.36 ex-GST weekly customer and supplier storage rates, and $250/$340.91 ex-GST one-time transport.
- Three Draft documents are calculated: `ACCREC` invoice on account 200 due one calendar day later, transport PO on account 310, and Containerzone storage PO on account 311. **Transport item codes use `JD 20` and `JD 40` by size, after an explicit owner choice and Xero GET validation.** A first event receives invoice suffix A and unsuffixed `JD`/`GD` PO numbers; further events reserve a per-Deal suffix, skipping deposit suffix D, and append it to both POs.
- A database table has **unique Deal + location + initial-period** and **unique Deal + suffix** keys. It retains per-document Draft read-back receipts for safe partial-failure reconciliation. The owner requested a **separate read-only Storage Drafts tab under Financial Operations → Document Operations**; it shows the Deal/location, period, event status and all three Xero references without any manual trigger buttons. No standalone app, recurring schedule, payment action or unrelated family activation was added.
- Future post-success traceability queues one VTiger note after all three exact Xero Draft read-backs. If VTiger note writing is disabled or fails, the three verified receipts remain successful and the event shows `writeback_pending` rather than recreating Xero documents.

## Live VTiger field mapping confirmed by authenticated `describe`

| Fact | Verified `Potentials` API field / source |
| --- | --- |
| Deal ID / number | `id` / `potential_no` |
| Storage stage | `sales_stage`: `4 STORAGE at ORIGIN`, `11 STORAGE at DEST` |
| Storage choice | `cf_potentials_storagerequired`: `Yes at Origin`, `Yes at Destination` |
| Container number / size | `potentialname` / `cf_potentials_containertype` |
| Date In / delivery cap | `cf_potentials_datein` / `cf_potentials_fullcontainerdeliverydate` |
| Organisation / contact | `related_to` / `contact_id` → `Accounts.accountname` or `Contacts.firstname`, `Contacts.lastname` |
| Origin / Destination driver | `cf_potentials_contractorc2` / `cf_potentials_fullcontainerdeliveryv` → `Vendors.vendorname` |
| VTiger note fields | `ModComments.related_to`, `ModComments.commentcontent`, `ModComments.assigned_user_id` |

Only the exact referenced records are retrieved. No broad VTiger scan or record update occurred.

## Blockers before any actual Draft or external webhook handover

1. **The JD item mismatch is resolved in code, not by changing Xero.** GET-only checks confirm the expected CONTAINERZONE tenant, active accounts **200/310/311**, and existing `JD 20` / `JD 40` purchased items with native purchase descriptions on account 310. `Items/JD` itself remains absent. The owner explicitly selected the existing size-specific items. PO document numbers still begin `JD`; only the Xero **item code** varies by container size.
2. The isolated deployment lock `FINANCIAL_INITIAL_STORAGE_ENABLED` remains unset. The broad financial live-write lock is also unset, global financial shadow mode remains active, and unrelated families cannot be enabled by the storage pilot. There is no named source or exact, expiring three-document approval with source/payload/Xero-preflight hashes and no confirmed legacy writer handoff. The route will accept authenticated events for local held/audit tracking, **not** create Drafts, until the exact pilot is confirmed and the narrow gate is intentionally armed.
3. Existing VTiger workflow destinations and the old Operations writer are **unchanged**, following the newer narrow attachment's explicit exclusion of existing VTiger workflows and Operations changes. This route is not claimed to receive live VTiger traffic yet. Once an exact pilot is reviewed, hand over just the relevant existing stage action in a separate coordinated change to avoid two writers.
4. Xero's exact customer/driver/Containerzone contact matches, existing document-number collisions, and selected `JD 20` / `JD 40` purchase wording must pass a fresh GET-only preflight for the named pilot. No arbitrary historical matching or suffix bypass is permitted. The current pilot approval is not available from a public/browser action.

The isolated Draft transport can be enabled for one persisted, expiring **Deal/location/period** approval only. A writer call rechecks that row is claimed, names the exact reference, has current source/document/preflight hashes, and records the legacy handoff; it accepts only a new `POST` containing exactly one `DRAFT` ACCREC invoice or purchase order. The broad all-family writer flags and shadow mode remain unchanged. Setting a flag alone cannot bypass the stored pilot approval.

### Candidate facts collected after the owner approved size-specific JD items

A bounded read-only VTiger query returned up to ten Deals in the exact current Origin or Destination storage stages, but **stage alone is not evidence of an unbilled Draft**. The most recently modified Destination Deal **D702885** has Date In **2026-10-05**, which was future-dated at the 2026-10-01 check. The AP workflow now holds future Sydney Date In values before reservation or Xero preflight. The next recent Origin Deal **D702839** was validated with Date In 2026-09-08, a 23-day initial period through 2026-09-30, but a GET-only Xero preflight found **all three expected numbers already present**: `INV-702839-A`, `JD702839`, `GD702839`. Its matching contact/item results do **not** justify recreating the documents or adding suffixes. Neither Deal was selected, approved, written or modified. A different exact pilot source must be named or selected for the first creation.

### D702885 — owner-confirmed reconciliation-only case (1 October 2026)

The owner confirmed the **new AP rules are authoritative for future storage events**. The later, exact authorisation for a **single new customer invoice Draft** does not authorise editing the original deleted invoice, the existing POs, pausing a writer, or activating the stage-triggered three-document webhook. Keep this case outside the new AP event/suffix ledger; a held reservation would otherwise consume the `A` suffix without completing that bundle.

VTiger exact Deal `5x484050`: stage `11 STORAGE at DEST`, storage required `Yes at Destination`, 20 Foot Standard container `GRRU2300868`, customer **Wez Jenkins**, destination driver **GM Towing**, Date In **2026-10-05**, delivery **2026-10-09**. The AP inclusive first period would be five days, 5–9 October; customer invoice date 5 October and due 6 October.

| Exact reference | New AP rule, if this were unbilled (ex GST / GST / total) | Current Xero record (ex GST / GST / total) |
| --- | --- | --- |
| `INV-702885-A` — Wez Jenkins | Storage-only $42.21 / $4.22 / $46.43, account 200 | **DELETED**. Former two-line invoice included transport and storage: $321.43 / $32.14 / $353.57, account 200; dated 5 Oct, due 6 Oct. Its exact number remains occupied for preflight purposes. |
| `JD702885` — GM Towing | $250.00 / $25.00 / $275.00, item `JD 20`, account 310 | **DRAFT** $275.00 / $27.50 / $302.50, item `JD 20`, account 310; Xero document date 1 Oct. |
| `GD702885` — CONTAINERZONE | $42.21 / $4.22 / $46.43, account 311 | **DRAFT** $35.72 / $3.57 / $39.29, item `GD 20`, account 311; Xero document date 1 Oct. |

The current AP three-document preflight detects the DELETED invoice and both DRAFT POs as exact-number collisions. The difference is **not merely GST rounding**: the legacy invoice also contained a transport line, and the PO unit/rate amounts differ from the new AP rule. Never suffix-bypass these records. The legacy shared VTiger storage action is still active and must be coordinated with ContainerZone Operations / IT for a future cutover; do not generate a test Deal while it remains active.

**One-off result:** At 18:31 AEST on 1 October 2026 the owner explicitly confirmed the exact storage-only invoice payload (Wez Jenkins, account 200, 5 October date, 6 October due date, $42.21 ex GST / $4.22 GST / $46.43 total) and requested one new Draft only. Xero's [official guidance](https://central.xero.com/0/article/Delete-or-void-a-sales-invoice) permits reuse of a **deleted Draft** number (not a voided approved invoice). After refreshing the Deal, tenant, contact and all three exact references, a single **create-only PUT `/Invoices`** submitted `ACCREC` `DRAFT` `INV-702885-A`, one Destination storage line and no PO or VTiger mutation. An exact ID read-back and independent number search verified **new Xero ID `64a83cc1-437c-4495-8186-d33b5df439de`**, status **DRAFT**, the approved dates, customer, line, $42.21 ex GST, $4.22 GST and $46.43 total. The original distinct ID `50162b52-5761-42da-8f3f-68aeba4d7475` remains **DELETED** with its old total $353.57; `JD702885` and `GD702885` remain **DRAFT** with their original $302.50 and $39.29 totals. AP writer execution **#1** is `succeeded` for this single create-only operation. This is **not** a test of the VTiger webhook, not a three-document AP event, and not an approval to correct either PO. The isolated AP automatic storage flag and generic financial flags remain unset.

## Example request / currently expected response

```http
POST /api/webhooks/vtiger/deal-storage
X-Financial-Webhook-Secret: <private AP-managed value>
Content-Type: application/json

{"record_id":"5x123456","event":"deal.storage-stage-changed"}
```

Until the named Deal, exact approval and deployment gates exist, a valid stage resolves to an HTTP 202 response resembling:

```json
{"ok":false,"status":"held","dealNumber":"D123456","location":"origin","warning":"Initial storage Drafts are prepared but the exact pilot approval, legacy handoff and deployment gates are not enabled."}
```

A three-document webhook success response cannot be represented as an observed result yet; all three-Draft event completions so far were mocked in automated tests. The separately authorised invoice-only result above must not be presented as such a completion.

## Validation and external-impact statement

- TypeScript check passed; **61 test files / 343 tests** passed after the exact deleted/voided invoice-number collision and same-number history guards, pilot-source, in-flight locking and persisted-approval gate refinements; production build passed. The focused tests cover both stages, exact names and account/payload shape, four rate types and JD item selection, pro-rata/DST/same-day periods, future-date and missing-data holds, deposit suffix exclusion, organisation priority, invalid secret, replay, collision, partial failure, pending VTiger note, and isolation of the storage-only writer gate.
- The new local endpoint returned **401** for an unauthenticated request; the new storage event table has **zero live events** at handoff.
- Only AP source files and one additive AP ledger migration changed for the stage-triggered implementation. The later one-off invoice-only test used the AP Xero OAuth connection and recorded an AP execution ledger receipt. **Only the explicitly approved new Xero customer Draft was created.** No existing Xero invoice or PO, VTiger record/workflow URL, Operations setting/schedule, Make scenario, financial Heartbeat job, or live writer flag changed.
