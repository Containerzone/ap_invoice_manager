# Container Control Asset Purchase Orders — AP Migration Handoff

**Status:** implemented in AP Management, **default-off**, and not published or activated.

## Implemented AP behavior

The dedicated Asset flow follows the authorised Operations behavior while remaining isolated from Storage and For Hire:

| Area | AP implementation |
|---|---|
| Source | Exact current VTiger `vtcmcontainercontrols` record, then exact referenced `Supplier Name` Vendor |
| Trigger eligibility | `Acquisition Type = ASSET` and `Status = REQUEST` only |
| Route | `POST /api/webhooks/vtiger/container-control-asset` with existing private AP webhook header |
| Reference | `A<Container Control Number>` — e.g. `AC1860` |
| Xero document | One new **Draft Purchase Order** only |
| Item / account | `Container Asset` / account `322` |
| GST / currency | GST-exclusive line, AUD |
| Source price | VTiger **Purchase Price INCL GST**, converted to GST-exclusive before Xero transport |
| Line description | Container ID, VTiger record ID, Asset, container type, grade, collection depot and purchase date; never VTiger rich-text notes |
| Preflight | Exact Xero PO reference, exact supplier contact and `Container Asset` item checked by GET before any write |
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

## Deliberately not activated

- No Asset policy record has been approved.
- `FINANCIAL_ASSET_PURCHASE_AUTOMATIC_ENABLED` remains unset.
- No VTiger Asset workflow or Operations action was changed.
- No Xero Asset PO was created during implementation.
- The AP Asset lifecycle ledger was newly created and is empty.

## Required later cutover statement

Before activation, explicitly confirm all of the following in the current conversation:

> At [Sydney date/time], the VTiger branch that posts to AP contains **Asset + Request only**, the Operations Asset PO writer is paused for new events, and the AP Asset migration applies to **new events only**. I approve automatic creation of **Xero Draft Purchase Orders only** using the Asset rules above; no authorisation, sending or payment.

Then publish the AP checkpoint, arm only `FINANCIAL_ASSET_PURCHASE_AUTOMATIC_ENABLED=true`, record the approved policy locally, send one qualifying new Asset event, and verify the exact `A…` Draft in the Container Asset POs workspace before expanding scope.

## Validation

- Additive migration: `0039_superb_blackheart.sql`
- TypeScript: passed
- Regression suite: **75 files / 450 tests** passed
- Production build: passed
- Local receiver check: unauthenticated request returned `401`; no source or Xero operation ran.
