# Container Control Asset Purchase Orders — AP Migration Handoff

**Status:** **live for new Asset / Request events only** from 11 October 2026, 21:06:52 Sydney. The deployment gate and the AP-local release policy are active; the first qualifying event has not yet been received.

## Implemented AP behavior

The dedicated Asset flow follows the authorised Operations behavior while remaining isolated from Storage and For Hire:

| Area | AP implementation |
|---|---|
| Source | Exact current VTiger `vtcmcontainercontrols` record, then exact referenced `Supplier Name` Vendor |
| Trigger eligibility | `Acquisition Type = ASSET` and `Status = REQUEST` only |
| Route | `POST /api/webhooks/vtiger/container-control-asset` with existing private AP webhook header |
| Reference | `A<Container Control Number>` — e.g. `AC1860` |
| Xero document | One new **Draft Purchase Order** only |
| Item / account | `20' Sale` for 20-foot containers or `40' Sale` for 40-foot containers / account `322` |
| GST / currency | GST-exclusive line, AUD |
| Source price | VTiger **Purchase Price INCL GST**, converted to GST-exclusive before Xero transport |
| Line description | Xero native placeholders resolved as `{Container Type} {What Condition Would you Like}` using current container type and grade; never VTiger rich-text notes |
| Preflight | Exact Xero PO reference, exact supplier contact and the selected `20' Sale`/`40' Sale` item checked by GET before any write |
| Completion | Exact Xero Draft ID/number/status/contact/date/line/total re-read before AP marks it successful |

## Safeguards

- A webhook body can only identify the Container Control; it **cannot** provide or override a supplier, price, account, GST, date or reference.
- The route returns `503` before any VTiger/Xero source read while `FINANCIAL_ASSET_PURCHASE_AUTOMATIC_ENABLED` is not exactly `true`.
- The release policy is default-off and requires a current administrator approval, Asset-only VTiger branch, Operations Asset handover and an effective date.
- The policy is **new events only**. A source last modified before its approved cutover time is held; AP does not create a Draft for it.
- Exact Xero PO collisions are held; AP does not adopt, overwrite or bypass existing Operations documents.
- A per-Container-Control AP ledger reservation and immutable payload hash prevent duplicate write attempts.
- Only a new Xero Draft PO POST is permitted. No authorisation, email, payment, void, deletion or update path exists in this feature.

## AP UI

Administrators now have **Container Asset POs** in the sidebar. It provides:

1. Current release and handover state.
2. An exact Container Control preview that performs current VTiger and Xero GET-only checks.
3. The AP lifecycle ledger showing previews, holds and verified Draft receipts.

## Active release record

| Control | Recorded state |
|---|---|
| Public receiver | Published and protected at `/api/webhooks/vtiger/container-control-asset` |
| Effective time | `2026-10-11T10:06:52.122Z` / 21:06:52 Australia/Sydney |
| AP policy | `ASSET-PO-c43939b57255767c`, enabled, current rules hash |
| Scope | `new_events_only` |
| VTiger branch / Operations handover | Confirmed Asset + Request only; Operations Asset writer paused for new events |
| Deployment gate | `FINANCIAL_ASSET_PURCHASE_AUTOMATIC_ENABLED=true` |
| Recurring schedule | None — this is event-driven Asset PO creation only |
| Initial state | 0 AP Asset events, 0 Asset Xero Drafts, 0 Asset writer executions |

The authenticated public receiver was tested with an invalid record identifier and returned `400` before any source or Xero action. It now processes only a valid future Asset webhook.

## First-event verification

After the next qualifying VTiger event, open **Container Asset POs** and verify one `A…` Xero Draft PO has the exact supplier, `Container Asset` item, account `322`, GST-exclusive amount, dates and source description. Any collision, stale source, missing source field/contact/item, or read-back mismatch must appear as a hold and must not be bypassed.

## Validation

- Additive migration: `0039_superb_blackheart.sql`
- TypeScript: passed
- Regression suite: **75 files / 450 tests** passed
- Production build: passed
- Published receiver checks: unauthenticated request returned `401`; authenticated invalid payload returned `400`; no source or Xero operation ran.
