# Xero Draft invoice line ordering — Deposit deduction

**Date checked:** 18 October 2026

## Observed behaviour

For `INV-702941`, the approved Deposit deduction was appended last in the outgoing API array. Xero persisted the correct line and amounts but returned/displayed that new line before the retained main-invoice lines.

## Supported API behaviour

Xero documents that an update should include each existing `LineItemID`; omission of an existing line item causes it to be deleted and recreated. The invoice schema has no line-position or sort-order field.

- Xero Accounting API Invoices: https://developer.xero.com/documentation/api/accounting/invoices
- Xero line-order discussion, including a reported Xero-support response: https://stackoverflow.com/questions/77115933/xero-rest-api-how-to-keep-order-of-lineitems

## Safety decision

The AP writer preserves existing Xero `LineItemID`s and original line descriptions. It cannot promise the visual position of a newly created deduction line, because Xero controls returned/displayed order. Forcing a requested order would require omitting every existing line ID and recreating all existing lines, which breaks immutable line identity and is not safe to enable without a separately approved policy and an exact-Draft amendment approval.
