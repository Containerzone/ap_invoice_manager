# D702975 — completed Transport PO Draft recovery

**Completed:** 17/11/26. **AP request:** 5700001 — Completed. **Scope:** D702975 only.

The owner explicitly approved these four Draft POs at 15:33:41 Sydney on 17/11/26. D702976, Main/Deposit invoices, bills, authorisation, sending and payments were excluded.

## Verified Xero results

| PO | Supplier | Exact description | Ex GST (AUD) | GST (AUD) | Total (AUD) | Status |
|---|---|---|---:|---:|---:|---|
| AD702975 | CONTAINERZONE | Empty Container Delivery | 466.14 | 46.61 | 512.75 | DRAFT |
| BD702975 | CONTAINERZONE | Full Container Collection | 501.25 | 50.13 | 551.38 | DRAFT |
| P702975 | Pacific National Services Pty Ltd | Pacific National Rail Cost | 1,975.61 | 197.56 | 2,173.17 | DRAFT |
| DD702975 | CONTAINERZONE | Full Container Delivery | 613.78 | 61.38 | 675.16 | DRAFT |
| **Total** | | | **3,556.78** | **355.68** | **3,912.46** | |

Each PO is dated **17/11/26**, AUD, GST-exclusive, with one quantity-one itemless line, account **310 — Transport Vendors**, tax **INPUT**, and an empty reference. Exact supplier IDs, line descriptions, amounts, line/header GST, totals and Draft status were verified by immutable Xero ID after each creation and in independent GET-only checks before and after AP reconciliation.

| PO | Immutable Xero ID |
|---|---|
| AD702975 | fa36d76f-0b05-4d96-9dec-4ba4341a89d0 |
| BD702975 | 23431c27-d87f-42cf-830d-61ca41aa9702 |
| P702975 | 8e60d59a-6909-439d-8d9b-3f7918f6bf74 |
| DD702975 | 176b11bd-5f58-4a47-be06-6e0ded46e76e |

## Source and execution

The original request was not found in the legacy `po_requests` ledger, including whitespace/raw-payload checks. VTiger's reported HTTP success therefore did not establish PO completion. The supplied FORM mapping was reconstructed from the current Deal **D702975 / 5x494589** and exact linked Quote **Q532331 / 13x494135**, not invented from the aggregate amount. The current Stage-1 source, component values, accounting tenant, active suppliers, account 310 and all four PO absences were checked before execution. Source costs were rechecked before each existing-service invocation. Blank/zero fields created nothing; no VTiger re-fire occurred.

The recovery invoked the existing Stage-1 writer once for each approved component. Four successful creation results and exact readbacks were recorded. No financial write retry was invoked.

## Preserved post-creation audit issue

The local wrapper's Axios ESM interceptor did not observe the service's separate CJS Axios instance. Its recorded counter remained zero despite the four successful creation results. This caused a post-creation local counter assertion, not a failed or missing Xero PO. **Do not claim the wrapper's immediate queued-POST interceptor guards ran.** Actual safety evidence is the fresh preflight, fixed existing-service templates, one-shot local reservation, source checks before each service call, existing duplicate/idempotency handling, creation results and exact independent readbacks.

The original held receipt and append-only event evidence were preserved without rewriting the original counter. Following independent verification, only AP request 5700001 was reconciled to Completed and exact counter alert 3630001 was resolved. No Xero or VTiger write occurred during reconciliation. The final independent verifier passed all four Drafts and the Completed AP record.

Evidence is retained under `/home/ubuntu/accounts_hire_handover/`: original hold receipt, before-reconciliation verification, current recovery receipt, append-only attempts, and final independent verification. The one-shot writer must not be replayed.

## Outstanding separate email issue

The attempted operational failure alert was rejected by SMTP authentication (**535**); delivery to the configured recipients is **not confirmed**. This was retained as open AP warning **3660001 — Operational alert email authentication failed**. Email credentials and recipient configuration were not changed or retried. Financial recovery is complete, but alert-email authentication needs separate attention.

This is an execution/audit record only. Application code, release policies, gates and schedules were not changed; no publication is needed for the completed POs.
