# Loaded-container storage → Xero Drafts: implementation handoff

**Status (1 October 2026): implemented in AP Management and tested, but intentionally not activated. No Xero financial document has been written.** This replaces the earlier broad storage cutover work for the initial stage-triggered workflow only. The two supplied attachments, `pasted_content_12.txt` and `pasted_content_13.txt`, contain the same specification.

## What is prepared

- A narrow authenticated `POST /api/webhooks/vtiger/deal-storage` endpoint accepts only `{"record_id":"5x123456","event":"deal.storage-stage-changed"}` with header **`X-Financial-Webhook-Secret`**. Never place the secret in a URL, UI screenshot, or report. Missing or invalid authentication returns HTTP 401; unconfigured authentication returns 503.
- The AP handler retrieves the current VTiger **Potentials / Deal** and its bill-to organisation or fallback contact and the location-specific vendor; it ignores supplied financial facts. It requires stage `4 STORAGE at ORIGIN` or `11 STORAGE at DEST` and a matching `Storage Required` value. Wrong stages and incomplete sources are held before any Xero financial call.
- Initial period uses Sydney **calendar dates**, including both Date In and end day: month-end, extended through next month-end when fewer than seven days remain, capped by Full Container Delivery Date. `Temporal.PlainDate` avoids DST drift. Four allowed container types use $59.09/$86.36 ex-GST weekly customer and supplier storage rates, and $250/$340.91 ex-GST one-time transport.
- Three Draft documents are calculated: `ACCREC` invoice on account 200 due one calendar day later, transport PO on account 310, and Containerzone storage PO on account 311. A first event receives invoice suffix A and unsuffixed `JD`/`GD` PO numbers; further events reserve a per-Deal suffix, skipping deposit suffix D, and append it to both POs.
- A database table has **unique Deal + location + initial-period** and **unique Deal + suffix** keys. It retains per-document Draft read-back receipts for safe partial-failure reconciliation and exposes a small read-only list inside the existing Financial Trigger Dashboard. No new dashboard/navigation, recurring schedule, payment action or unrelated family activation was added.
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

1. **Material Xero item mismatch.** A GET-only check of the expected CONTAINERZONE tenant found accounts **200, 310 and 311 active**, but `Items/JD` returned **404**. `JD 20` and `JD 40` exist with native descriptions. The supplied instruction explicitly requires item code `JD`; the implementation therefore **holds** rather than silently substituting a different item. The owner must choose whether to use the existing size-specific codes or arrange a separate, approved JD-item setup in Xero.
2. The narrow deployment lock `FINANCIAL_INITIAL_STORAGE_ENABLED` and existing financial live-write/post-success locks remain unset; global financial shadow mode remains the default. There is no named source or exact, expiring three-document approval with source/payload/Xero-preflight hashes and no confirmed legacy writer handoff. The route will accept authenticated events for local held/audit tracking, **not** create Drafts, until these gates and the JD mismatch are resolved after a named-document approval.
3. Existing VTiger workflow destinations and the old Operations writer are **unchanged**, following the newer narrow attachment's explicit exclusion of existing VTiger workflows and Operations changes. This route is not claimed to receive live VTiger traffic yet. Once an exact pilot is reviewed, hand over just the relevant existing stage action in a separate coordinated change to avoid two writers.
4. Xero's exact customer/driver/Containerzone contact matches, existing document-number collisions, and `JD` item wording must pass a fresh GET-only preflight for the named pilot. No arbitrary historical matching or suffix bypass is permitted. The current pilot approval is not available from a public/browser action.

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

A document-specific real success response cannot be represented as an observed result yet; all successful three-Draft results so far were mocked in automated tests.

## Validation and external-impact statement

- TypeScript check passed; **60 test files / 336 tests** passed; production build passed. The focused tests cover both stages, exact names and account/payload shape, four rate types, pro-rata/DST/same-day periods, deposit suffix exclusion, organisation priority, missing-data holds, invalid secret, replay, collision, partial failure and pending VTiger note.
- The new local endpoint returned **401** for an unauthenticated request; the new storage event table has **zero live events** at handoff.
- Only AP source files and one additive AP ledger migration changed. The Xero and VTiger verification calls were read-only accounting/metadata/retrieve calls (VTiger authentication used its required challenge/login exchange). **No Xero financial document, VTiger record/workflow URL, Operations setting/schedule, Make scenario, or financial Heartbeat job was changed.**
