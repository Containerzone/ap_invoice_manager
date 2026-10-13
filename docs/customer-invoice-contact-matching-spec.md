# Customer Invoice Contact Matching and Fallback Rules

**Source:** `ContainerZoneAccountsAgent—CustomerInvoiceContactMatchingandFallbackRules.pdf` received 13 October 2026.

## Scope

Apply these rules to customer-invoice workflows: Main Customer Invoice, Deposit Invoice, Extra Hire, Storage customer invoices, Warranty customer invoices, and related Draft updates. Never apply supplier/fuzzy matching rules.

## Source resolution

1. Re-read the current VTiger Deal and linked Account/Contact records.
2. Resolve a usable organisation name in this order: `organizationname`, `accountname`, `cf_potentials_organizationname`, then the linked Account name from `related_to`/`relatedto`.
3. If no organisation exists, resolve an individual name from `contactname`, `cf_potentials_contactname`, then the linked Contact full name from `contact_id`.
4. Resolve email in this order: linked Contact `email`, linked Contact `email1`, Deal `email`, Deal `cf_potentials_contactemail`.
5. Retain the Deal ID, Account ID, Contact ID, fields used, billing kind, resolved name/email, timestamp and a non-secret snapshot hash for audit.
6. A blank/invalid required identity is held as `held_missing_customer_identity`; no Xero Contact or invoice is created.

## Exact matching

- Match only Xero `Contact.Name` and `Contact.EmailAddress`.
- Normalize names with trim, internal whitespace collapse and `toLocaleLowerCase("en-AU")`; preserve source casing for display/payload.
- Normalize email with trim and case-insensitive comparison.
- Do not use fuzzy, first-token or partial matches.

### Organisation billing

1. Search exact normalized Xero `Name` for the organisation first.
2. One exact active name match wins, even if a linked-person email differs.
3. If no organisation name match exists, use email only to determine whether that email is already used; never redirect the organisation invoice to a person matching that email.
4. If creation is required, create the organisation with `Name` and include `EmailAddress` only when the usable email did not already match a Xero Contact.

### Individual billing

1. Search exact normalized Xero `EmailAddress` first when there is a usable email.
2. If multiple email results include exactly one exact normalized intended-name match, select that contact.
3. If email results exist but none has the exact intended name, use the first returned email result deterministically and record `email_match_name_not_exact`.
4. If no usable email match exists, search exact normalized `Name`; one match wins, more than one is held, and no match requires creation.

## Contact creation and Draft binding

- In preview/shadow mode, return `would_create_contact`; never write.
- In live mode, create exactly one Contact only after current duplicate/contact evidence is refreshed and the separate v2 contact gate is enabled.
- POST only `{ Contacts: [{ Name, EmailAddress? }] }`; never update existing Xero Contacts.
- Require one returned `ContactID`, GET/read it back, bind only that immutable ID to the new ACCREC Draft, then perform a fresh full invoice preflight before Draft creation.
- A failed/uncertain creation is `held_xero_contact_creation_failed` or reconciliation-required; no invoice Draft is written.

## Existing Draft amendments

For an existing Draft invoice amendment, retrieve the exact Draft by immutable ID, require `ACCREC` and `DRAFT`, keep `Invoice.Contact.ContactID`, and do **not** run new customer matching. Hold non-Drafts.

## Audit and administrator review

Persist non-secret source provenance, lookup sequence/outcome, selected/proposed Contact ID and display name, creation decision, timestamps and reconciliation state. The admin review UI must show this evidence without credentials or webhook secrets.
