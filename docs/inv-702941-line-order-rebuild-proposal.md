# Exact Xero Draft rebuild proposal — `INV-702941`

**Prepared:** 18 October 2026  
**Status:** Proposal only — no Xero update has been made or authorised by this document.

## Objective

Ask Xero to display the existing Deposit deduction as the **last** line on the exact current Draft invoice `INV-702941`.

Xero has already accepted the financially correct deduction but displayed its newly created line first. The normal safe writer keeps existing `LineItemID`s; Xero controls the visual order in that mode. This proposal is a one-time exception: it requests recreation of all three lines in a specified order, so it necessarily replaces the current Xero line identities.

## Exact current snapshot

| Field | Verified value |
|---|---|
| Xero Invoice ID | `947fe696-7cf2-4f1d-8104-22f9d63c213e` |
| Invoice number | `INV-702941` |
| Type / status | `ACCREC` / `DRAFT` |
| Contact | Kyle Ram — `1aad0d65-d003-4e15-b04f-6bca96beb18b` |
| Date / due date | 15 October 2026 / 29 October 2026 |
| Reference | `Q531794` |
| Currency / amounts | AUD / tax exclusive |
| Branding theme | `16ff022c-95e9-47e9-852b-34e5b958e7da` |
| Subtotal / GST / total | $4,006.53 / $400.66 / $4,407.19 |
| Immutable snapshot SHA-256 | `0d74ed36afbaac8828d8ad793a23496c78d6d4a13be9142e17a12bbd2eb3a4c2` |

## Proposed one-time Xero update

**Method / endpoint:** `POST /Invoices/947fe696-7cf2-4f1d-8104-22f9d63c213e`  
**Important:** The payload deliberately omits every existing `LineItemID`. Per Xero’s documented invoice update behaviour, that causes the existing lines to be deleted and recreated in the supplied array order.

```json
{
  "Invoices": [
    {
      "InvoiceID": "947fe696-7cf2-4f1d-8104-22f9d63c213e",
      "InvoiceNumber": "INV-702941",
      "Type": "ACCREC",
      "Status": "DRAFT",
      "Contact": {
        "ContactID": "1aad0d65-d003-4e15-b04f-6bca96beb18b"
      },
      "Date": "2026-10-15",
      "DueDate": "2026-10-29",
      "Reference": "Q531794",
      "CurrencyCode": "AUD",
      "LineAmountTypes": "Exclusive",
      "BrandingThemeID": "16ff022c-95e9-47e9-852b-34e5b958e7da",
      "LineItems": [
        {
          "ItemCode": "SER60",
          "Description": "20 Foot Standard Height Container Hire per 30 days",
          "Quantity": 1,
          "UnitAmount": 209.25,
          "AccountCode": "200",
          "TaxType": "OUTPUT",
          "TaxAmount": 20.93,
          "Tracking": []
        },
        {
          "ItemCode": "SER60",
          "Description": "Empty & Loaded Container from BRENDALE, 4500, QLD to MORPHETT VALE, 5162, SA",
          "Quantity": 1,
          "UnitAmount": 4251.83,
          "AccountCode": "200",
          "TaxType": "OUTPUT",
          "TaxAmount": 425.18,
          "Tracking": []
        },
        {
          "Description": "Less deposit invoice INV-702941-D",
          "Quantity": 1,
          "UnitAmount": -454.55,
          "AccountCode": "200",
          "TaxType": "OUTPUT",
          "TaxAmount": -45.45,
          "Tracking": []
        }
      ]
    }
  ]
}
```

The proposal changes **only** the Xero line identities and requested array order. It preserves every current header, customer, currency, amount, account, tax treatment, item code, tracking selection and original description verbatim. No VTiger record, contact, Deposit invoice, approval, send action or payment is included.

## Mandatory execution guards

Before any update, AP must perform a fresh GET-only read and abort unless the complete current Draft is still exactly the snapshot above, including its status, header fields, totals and all three pre-rebuild lines. After one update only, AP must GET the same Draft and verify:

1. It remains the exact `DRAFT` `ACCREC` resource and all header/financial fields equal the table above.
2. The three recreated lines exactly match the payload values and descriptions.
3. The returned/displayed order is Hire line, transport line, then `Less deposit invoice INV-702941-D` last.

If Xero does not return the requested order, AP must **not retry**, change the payload, or make another write. It must retain the post-write evidence as a reconciliation hold.

## Risk and approval boundary

This is not suitable for the automatic Deposit workflow. Removing all `LineItemID`s intentionally replaces immutable Xero line identities. It requires a fresh, separate approval that states the exact target `INV-702941`, the three-line payload above, and that all existing line identities may be replaced.

References: [Xero Accounting API — Invoices](https://developer.xero.com/documentation/api/accounting/invoices) and [line-order investigation](xero-line-item-ordering.md).
