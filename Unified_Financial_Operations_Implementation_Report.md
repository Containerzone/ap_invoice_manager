# Unified Financial Operations — Implementation and Activation Boundaries

**Application:** ContainerZone Supplier Invoice Manager  
**Scope:** AP Management project only  
**Prepared:** 29 September 2026  
**Current operational state:** **proposal, verification and approval readiness only — no financial live execution route or schedule is enabled**

## What has been implemented

All financial functions now live under the single **Financial Operations** parent workspace. The implementation preserves the existing AP invoice/bill flow and does **not** modify Supplier Sourcing CRM, existing VTiger workflow URLs, existing Heartbeat schedules, or existing Xero documents.

| Capability | Implementation status | External financial effect now |
|---|---:|---|
| Financial workflow evaluators | Implemented across the 14 documented families | None — proposals only |
| Exact VTiger source retrieval | Implemented for named records | Read-only |
| Xero tenant, duplicate, contact and item preflight | Implemented | GET-only |
| Immutable proposal evidence | Implemented | Local database only |
| Source/rules/proposal/preflight hashes | Implemented | Local database only |
| Administrator approval workbench | Implemented | Local audit record only |
| Draft-only Xero transport | Implemented but unregistered | None |
| Xero post-write Draft read-back | Implemented but unregistered | None |
| Post-success VTiger note/task/end-date ledger | Implemented as pending local records | None |
| Proposal-only AP webhooks | Implemented, configuration-gated and paused by default | No Xero or VTiger write |
| Recurring hire/storage schedule definitions | Documented but disabled | No Heartbeat task |

## Financial families retained

The release model retains these families under the same Financial Operations workspace:

1. Initial Container Control — Asset
2. Initial Container Control — Customer Sale
3. Initial Container Control — For Hire
4. Recurring For Hire
5. Origin Storage Activation
6. Destination Storage Activation
7. Recurring Storage
8. Storage Finalisation / Recovery
9. Main Customer Invoice
10. Deposit Invoice
11. Final Weight — Overweight
12. Final Weight — Underweight
13. Extra Hire
14. Warranty Customer Invoice and Aviso PO

## The current approval chain

For a **named proposed document**, an administrator can now use **Financial Operations → Review & Evidence → Proposal Approvals** to perform the following non-write process:

1. Select one immutable create-Draft or update-Draft proposal.
2. Refresh the exact current VTiger source record through an authenticated read-only query.
3. Re-evaluate the same workflow against the current effective AP rules.
4. Require exactly one matching proposal; any change to source data, rules, document payload or proposal reference blocks approval.
5. Run a fresh Xero GET-only preflight that requires:
   - one exact Xero contact **and ContactID**;
   - all needed Xero item codes;
   - no duplicate for a new Draft; or one exact existing **DRAFT** ID for an update;
   - no unresolved GST configuration.
6. Record a 20-minute, single-use approval with the administrator's reference and acknowledgement.

The approval record contains the immutable source, rules, proposal and Xero preflight hashes. **It sends no Xero request.**

## Guarded future Draft execution

The future execution coordinator is deliberately more restrictive than a normal Xero call:

- only `create_draft` or `update_draft` is accepted;
- only Purchase Orders and ACCREC customer invoices are supported;
- updates require the exact Xero ID, reference and `DRAFT` status;
- name-only contacts are rejected: the current Xero preflight ContactID must be used;
- a deterministic Xero idempotency key is retained over one transient 502/503/504 retry only;
- an execution row is recorded before any transport attempt;
- after a write response, the exact Xero ID/reference/status is re-read with a GET request before local success is recorded;
- an uncertain response or failed read-back goes to **reconciliation required**, never a blind repeated write;
- non-Draft amendment, authorisation, payment, void, deletion and bulk replay remain unavailable.

The writer has **no registered tRPC mutation, public route, webhook or Heartbeat task**. `FINANCIAL_LIVE_WRITES_ENABLED` remains a deployment environment lock and cannot be changed from the UI.

## Post-success actions

A verified future Xero Draft would create a local, idempotent **pending** post-success action (for example a VTiger note, task, or hire-end-date action). No VTiger mutation is registered. This prevents a successful financial document from being mistaken for proof that a CRM mutation also succeeded.

## Required activation evidence for a future document-specific request

Before any financial write can be considered, the administrator must provide and approve the exact payload context:

| Required item | Why it is required |
|---|---|
| Named source record and workflow family | Prevents broad searches and mass execution |
| Current source read evidence | Confirms the price, dates, counterparty and business condition have not changed |
| Confirmed GST treatment, especially storage customer invoices | Prevents tax inference |
| Exact Xero contact and ContactID | Prevents accidental contact creation or a name collision |
| Exact Xero item/account mapping | Prevents posting to an incorrect account or item |
| New Draft duplicate check or exact existing Draft target | Prevents duplicate documents and non-Draft modification |
| Existing writer handoff/disable evidence | Prevents a legacy writer and AP writer creating the same document |
| Schedule/event registration details, where relevant | Prevents accidental historical replay or duplicate recurring runs |
| Document-specific approval reference and acknowledgement | Creates an accountable, narrow authorisation |
| Rollback/reconciliation owner | Ensures an uncertain response is investigated rather than retried blindly |

## Verification completed

- TypeScript type check passes.
- **51 test files / 278 tests** pass.
- Production build passes.
- The existing AP invoice/bill workflows remain outside this new execution path.
- No Xero accounting document, payment, contact, existing PO/bill, VTiger record, workflow URL or schedule was created, changed, authorised, voided or deleted during this implementation.

> **Important:** This report does not authorise a financial write. A future request must name the exact document(s), source record(s), counterparty, amounts, GST treatment and material execution choices before the final confirmation gate can be presented.
