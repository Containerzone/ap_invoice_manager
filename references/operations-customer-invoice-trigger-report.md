# ContainerZone PO and Customer Invoice Trigger Report

**Prepared:** 25 September 2026  
**Scope:** Current CRM-owned Xero purchase-order and customer-invoice automation. This report describes what causes a document to be created or updated. It does not create, authorise, send, void, or amend any financial document.

## Executive summary

The current automation uses three distinct trigger types. **VTiger event webhooks** create first-time documents when a Container Control or Deal reaches the relevant operational condition. **Scheduled first-of-month processes** create ongoing hire and storage billing only after the applicable billing period is due. **Finalisation webhooks** either stop billing, adjust existing Draft storage documents, or create a final capped period where an unbilled period remains.

Every automated Xero document is initially created as a **Draft**. The CRM does not automatically authorise, send, pay, void, or replace a non-Draft document. Retried workflows are designed to be idempotent: they either return the existing outcome, recover only missing references, or hold the matter for review rather than create a second document.

> **Important distinction:** A VTiger workflow determines *when the CRM endpoint is called*. The CRM then validates the live Deal or Container Control before creating a document. Several invoice endpoints do not contain a hard-coded stage test, because their specific VTiger workflow is the stage or field-change trigger.

## 1. Trigger map at a glance

| Family | Trigger source | Stage or field condition | Documents created or updated | Timing |
|---|---|---|---|---|
| Container Control acquisition | VTiger Container Control creation webhook | The current VTiger rule is **REQUEST**. The CRM does not independently test CC status. | One Draft supplier PO: Asset `A…`, Customer Sale `S…`, or initial For Hire `H…` | Immediately after the VTiger webhook is received |
| Ongoing supplier container hire | Project schedule | Container Control Acquisition = **FOR HIRE** and status = **ON HIRE** or **IDLE**; the next 30-day extension must be due | One Draft recurring hire PO `H…-2`, `H…-3`, etc. | Schedule runs on the **1st of each month** at 00:00 UTC |
| Loaded-container storage activation | VTiger storage activation webhook | Deal stage contains **STORAGE at ORIGIN** or **STORAGE at DEST**; valid live container, customer, Date In and allocated transport supplier required | One Draft customer storage invoice, one Draft JD transport PO, and one Draft GD storage PO | Immediately after the webhook is received |
| Ongoing loaded-container storage | Project schedule | Active storage event with a due next-billing date | One Draft recurring storage invoice and one Draft recurring GD storage PO; no new JD PO | Daily schedule, but creates documents only on the **first Sydney calendar day** of the month |
| Storage finalisation / recovery | VTiger finalisation webhook | Explicit origin/destination request plus Date Out or Full Container Delivery Date | May create a final Draft invoice and GD PO, recover a missed first invoice/JD/GD set, or adjust existing Draft documents | Immediately after finalisation webhook; only if the applicable financial condition exists |
| Main customer invoice | VTiger main-invoice webhook | The configured VTiger workflow calls the endpoint. A linked Quote with billable lines is required. | One Draft `INV-<Deal>` main invoice; may also create a matching warranty PO | Immediately after webhook |
| Deposit invoice | VTiger deposit-invoice webhook | Deposit Status blank or `Pending`, positive Deposit Amount Required, and no existing `-D` invoice | One Draft `INV-<Deal>-D` deposit invoice; may add a negative deposit deduction to the Draft main invoice | Immediately after webhook |
| Final main-invoice weight adjustment | VTiger stage 9 / final-weight webhooks | Existing Draft main invoice plus final weight values. Underweight must be less than estimated weight. | **No new invoice**; updates Draft main invoice only | Immediately after weight webhook |
| Customer extra hire | VTiger extra-hire webhook | Hire Duration = 30 days; valid Hire End Date, container number and 20/40-foot type | One Draft suffix invoice `INV-<Deal>-A/-B/-C/-E…`; advances Hire End Date | Immediately after webhook |
| Warranty | VTiger Added Services change webhook or main-invoice creation | Exactly one supported `Warranty $Xk` selection in Added Services | Adds/reconciles a warranty line on Draft main invoice, or creates one Draft warranty suffix invoice; creates matching Draft Aviso PO | Immediately after webhook |

## 2. Purchase orders created from Container Control records

### 2.1 Initial supplier purchase or hire PO

**Trigger:** The current VTiger Container Control rule fires at **REQUEST** and calls `/api/webhooks/vtiger-cc-created`. The webhook determines the PO category from the Container Control’s **Acquisition** field. The CRM code does not itself require `READY`, `ON HIRE`, or `IDLE`, but it only acts when VTiger dispatches the webhook. Therefore, under the current VTiger configuration, the initial PO is created at `REQUEST`; simply moving the record to `READY` or `ON HIRE` does not create a delayed initial PO.

| Acquisition type | Draft PO reference | Account | Required financial source | Line-item treatment |
|---|---|---:|---|---|
| **Asset** | `A<CC number>` | 322 | Purchase price or cost from the Container Control; the incoming GST-inclusive value is converted to ex GST | One PO line using the operational container description. Rich-text VTiger Notes are excluded. |
| **Customer Sale** | `S<CC number>` | 322 | Purchase price or cost from the Container Control; the incoming GST-inclusive value is converted to ex GST | One PO line using the operational container description. Rich-text VTiger Notes are excluded. |
| **For Hire — initial** | `H<CC number>`; for example, CC number `C1860` becomes `HC1860` | 312 | Populated monthly cost, converted from GST-inclusive to ex GST. If no cost is stored, defaults are **$120 ex GST for 20-foot** and **$240 ex GST for 40-foot**. | Item code **HC 20** or **HC 40**. Description: `20' / 40' Container Hire from {Collection Date} to {Collection Date + 30 days}`. Quantity 1. Optional Lift & Booking Fees are included as a second line only on the initial PO. |

The initial For Hire PO requires a supported 20- or 40-foot container type, a Collection Date and a positive resolved cost. The CRM retrieves the live Container Control if the webhook payload omitted any of those dated hire values. A zero or unresolved cost does not create a PO.

### 2.2 Ongoing supplier container-hire POs

**Trigger:** The active `forHireMonthlyPo` project schedule runs at **00:00 UTC on the first day of each month**. The current next run shown by the project schedule is **1 October 2026, 00:00 UTC**. It reads VTiger Container Controls and keeps only those where:

- Acquisition is **FOR HIRE**; and
- Status is **ON HIRE** or **IDLE**.

`DEHIRED` records are excluded, so they do not receive a new ongoing hire PO. `REQUEST` and `READY` are also excluded from the recurring schedule. The actual next 30-day period must already be due; otherwise the Container Control is deferred without creating a PO.

| Attribute | Recurring-hire rule |
|---|---|
| PO reference | Next gap-safe sequence after the original hire reference: `HC1860-2`, `HC1860-3`, and so on. |
| Account | 312 |
| Item code | **HC 20 E** for 20-foot or **HC 40 E** for 40-foot |
| Description | `{Container Number}, {Container Type} Extended Hire @ ${daily rate} per day from {start date} to {end date}` |
| Quantity | 30 days |
| Rate | Purchase-side daily rate held on the relevant Xero extension item, read live at execution time |
| Billing periods | The first extension begins one day after the initial 30-day-hire period. Each later extension is a consecutive 30-day period. |

A CRM run ledger reserves one recurring PO per Container Control per Sydney calendar month before Xero is called. A retry confirms a matching Xero PO before repairing the ledger, instead of allocating a new suffix.

## 3. Purchase orders and invoices created from loaded-container storage

### 3.1 Storage planning creates no financial document

**Trigger:** A VTiger workflow calls `/api/webhooks/vtiger-storage-import` when Storage Required is marked as Origin or Destination. The CRM creates or refreshes a **planned** storage event. It does not create a customer invoice, JD PO, or GD PO at this point. Date In is allowed to be absent while storage is being sourced.

### 3.2 Storage activation creates the first document set

**Trigger:** A VTiger workflow calls `/api/webhooks/vtiger-storage` once the Deal reaches a storage stage. The CRM determines the location directly from the live stage text:

| Live Deal stage text contains | Storage location |
|---|---|
| `STORAGE at ORIGIN` | Origin |
| `STORAGE at DEST` | Destination |

The activation requires a container number, a supported 20- or 40-foot type, an Xero customer, **Date In**, and an allocated collection driver for origin or delivery driver for destination. The CRM refreshes these values from the live Deal at activation; it does not rely only on values captured at planning.

A valid activation creates the following **three Draft documents**:

| Document | Reference / number | Account | Content |
|---|---|---:|---|
| Customer invoice | Next available `INV-<Deal>-A/-B/-C/-E…` suffix; `-D` is reserved for the deposit | 200 revenue lines | One JD transport line plus first-period GD storage line. The organisation name is used before the contact name when available. |
| Transport PO | `JD<Deal>`; if another storage location already exists for the same Deal, it uses the invoice suffix | 310 | One **JD 20** or **JD 40** transport-to-storage line. |
| Storage PO | `GD<Deal>`; if another storage location already exists for the same Deal, it uses the invoice suffix | 311 | One **GD 20** or **GD 40** weekly storage line. |

For 20-foot storage, the customer storage rate is $65 per week, the supplier rate is $50 per week and the transport rate is $275 ex GST. For 40-foot storage, the corresponding rates are $95, $70 and $375 ex GST. Quantities are calculated as the exact billable number of days divided by seven. The first period ends at the current Sydney month end, except where fewer than seven billable days remain, in which case it extends to the following month end. A known delivery date caps the period.

### 3.3 Ongoing loaded-container storage billing

**Trigger:** The enabled `storage-monthly-billing` schedule posts to `/api/scheduled/storageMonthlyBilling` every day at **13:05 UTC**, but its handler acts only on the **first Australia/Sydney calendar day**. The next scheduled call is 25 September 2026 at 13:05 UTC; it will be a no-op unless that time is the first Sydney day of a month.

For every active storage event whose `nextBillingDate` is due, the schedule creates:

| Document | Rule |
|---|---|
| Customer invoice | A new Draft suffix invoice with **only** the GD storage line. No second transport charge is added. |
| Storage PO | A new Draft recurring GD PO, using the next numeric sequence after the first GD PO, such as `GD702812-1`. |
| Transport PO | **Not created** after the initial activation. |

Each invoice period is stored before the next billing date advances, so an already-recorded period does not generate another invoice or PO.

### 3.4 Storage finalisation can create, adjust, or stop documents

**Trigger:** A VTiger workflow calls `/api/webhooks/vtiger-finalise-storage` with an explicit `storageLocation` of `origin` or `destination` after **Date Out** or **Full Container Delivery Date** is entered. The endpoint reads the live date from the Deal.

The financial outcome depends on the storage-event state and final date:

| Situation at finalisation | Financial outcome |
|---|---|
| Active event; final date after the billed-through date | Creates one final capped Draft customer storage invoice and one Draft GD storage PO for the unbilled period. No JD PO is created. |
| Active event; final date falls inside an already billed period | Amends the matching **Draft** invoice and **Draft** GD PO to the true final date and recalculated amount. If either record is non-Draft, it logs a review requirement and does not amend it. |
| Planned or prematurely finalised event with no financial references | Controlled recovery creates the missing first Draft customer invoice, JD PO and GD PO, provided all live activation values and the final date are present. |
| Finalisation is repeated with a later date | May create the unbilled extension invoice and GD PO; repeated runs do not deliberately create a second document for the same stored period. |
| Finalisation is repeated with an earlier revised date | Adjusts the matching Draft invoice and GD PO where permitted. |

When Date Out is entered at a stage beginning **4**, **5**, or **6**, finalisation also creates a VTiger Accounts task called **Finalise Storage Invoice**. That task does not itself create a customer invoice or PO.

## 4. Customer invoice creation and update triggers

### 4.1 Main invoice

**Trigger:** The VTiger workflow that previously called the Make.com “xero main invoice webhook” now calls `/api/webhooks/vtiger-main-invoice`. The stage is not hard-coded inside the CRM endpoint; the relevant configured VTiger workflow decides the lifecycle point at which it dispatches.

The CRM retrieves the current Deal, its linked Quote and the Quote’s billable service lines. It creates **Draft `INV-<Deal digits>`** only if that number does not already exist in Xero. Each Quote line uses the VTiger Service name, quantity and list price. The invoice is issued to the organisation name if present; otherwise it uses the linked contact.

A supported warranty selected in **Added Services** is appended during main-invoice creation. The matching Aviso warranty PO is then created as part of the same warranty workflow.

### 4.2 Deposit invoice

**Trigger:** The VTiger deposit workflow calls `/api/webhooks/vtiger-deposit-invoice`. The endpoint has no hard-coded Deal stage. Its live field conditions are:

- Deposit Status is blank or `Pending`;
- Deposit Amount Required is greater than zero; and
- `INV-<Deal>-D` does not already exist.

The CRM creates a **Draft GST-inclusive deposit invoice** using item code `Deposit Required`. Its number is `INV-<Deal>-D`. If the main invoice is still Draft, the CRM retains the existing main-invoice lines and adds one negative `Deposit Required` deduction line. A non-Draft main invoice is left unchanged.

The deposit due date is one Sydney day after the trigger where Empty Container Supply Date or Full Container Pickup Date is within 14 days; otherwise it is seven Sydney days after the trigger.

### 4.3 Final main-invoice weight adjustment: stage 9 workflow

**Trigger:** The supplied Make blueprint identified this as the **VTiger stage 9 webhook**. The CRM replacement has two endpoints:

| Webhook | Condition | Outcome |
|---|---|---|
| `/api/webhooks/vtiger-finalise-main-invoice` | Actual Weight exceeds Estimated Weight and Per Extra Tonne is positive | Updates the existing Draft main invoice by adding or replacing a single **SER70** excess-weight line. |
| `/api/webhooks/vtiger-finalise-main-invoice-underweight` | Actual Weight is lower than Estimated Weight | Updates only the due date on the existing Draft main invoice; it does not create a negative SER70 line. |

Neither route creates a new customer invoice. Both require `INV-<Deal>` to exist and remain **Draft**. The due date is set to one day before Full Container Pickup Date when present, or the next Sydney day if that date is absent.

### 4.4 Customer extra-hire invoice

**Trigger:** The VTiger **Extend Hire Duration Invoice Automation Webhook** calls `/api/webhooks/vtiger-extra-hire-invoice`. It is designed for a 30-day extension and has no hard-coded stage test in the CRM.

The endpoint requires Hire Duration = 30 days, a valid current Hire End Date, a container number, and a supported 20- or 40-foot container type. It creates the next available Draft suffix invoice, permanently skipping `-D`, then advances the Deal’s Hire End Date to the new extension end.

| Container size | Xero item | Rate ex GST | Quantity | Account |
|---|---|---:|---:|---:|
| 20 foot | `20' Hire` | $45.00 per week | 4.286 weeks | 210 |
| 40 foot | `40' Hire` | $70.00 per week | 4.286 weeks | 210 |

The invoice covers 30 days from the day after the current Hire End Date through day 30. It uses the container number as the Xero reference and has a due date 30 days after the extension start. The workflow records the Deal number plus source Hire End Date, preventing a second invoice for the same extension period.

### 4.5 Warranty customer invoice and matching PO

**Trigger:** VTiger saves a Deal after the **Added Services** field changes and calls `/api/webhooks/vtiger-warranty-reconcile`. The workflow uses only Added Services; it does not use the Warranty Confirmed checkbox.

If exactly one supported warranty is selected, the outcome depends on the main invoice’s state:

| Main invoice state | Customer invoice outcome | Supplier PO outcome |
|---|---|---|
| Main invoice does not exist | No invoice is created; the reconciliation waits for main-invoice creation. | No PO until there is a tracked warranty invoice. |
| Draft main invoice | The warranty line is added, replaced or removed on the existing Draft invoice. All non-warranty Xero lines retain their native descriptions and line identifiers. | Draft **`I<Deal>`** warranty PO is created or reconciled. |
| Non-Draft main invoice and a warranty is selected | One warranty-only Draft suffix invoice is created, using the next available suffix other than `-D`. | Draft **`I<Deal>`** warranty PO is created or reconciled. |
| Non-Draft warranty invoice/PO differs from a new selection | No automatic replacement document is created. | The CRM records a review requirement. |

The matching supplier PO is issued to **Aviso Broking Pty Ltd**, account **313**, using the same WAR item code, native Xero item description and GST-exclusive premium as the customer warranty charge.

## 5. Current schedule status

The following document-related background schedules are currently enabled. The timing below is the live project configuration, not just code intent.

| Schedule | Enabled | Current timing | Purpose |
|---|---:|---|---|
| `forHireMonthlyPo` | Yes | 00:00 UTC on day 1 of every month | Creates due recurring For Hire supplier POs for ON HIRE and IDLE Container Controls. |
| `storage-monthly-billing` | Yes | Every day at 13:05 UTC; executes financial billing only on Sydney day 1 | Creates due recurring loaded-container storage invoices and GD POs. |
| `xero-receivables-hourly` | Yes | Hourly | Reconciles payment/amount-owing status to VTiger. It does **not** create invoices or POs. |
| `containerzone-monthly-underwriting-declaration` | Yes | Daily at 12:50 and 13:50 UTC; acts only on Sydney month-end | Creates the monthly broker declaration report. It does **not** create invoices or POs. |

## 6. Controls that apply across the financial workflows

The Xero creation helpers create **Draft** documents and validate configured Xero item codes before submitting the Xero request. The CRM resolves an existing Xero contact when possible and creates a contact only when the selected supplier or customer is not already present.

The main invoice, deposit invoice, extra-hire invoice, warranty invoice and storage invoice paths use Xero-number checks and internal idempotency records where a repeated event could otherwise create another financial document. Storage activation also checks JD and GD reference availability before creation. Recurring hire uses a monthly reservation ledger and Xero confirmation check. Warranty uses one tracker per Deal and stops on a non-Draft mismatch.

The automated workflows do not authorise or void documents. The existing CRM user interface has manual actions for storage-invoice authorisation and voiding, which are separate from the creation triggers described here.

## 7. Operational reading guide

When investigating a missing document, first identify the intended family. Then check the trigger that owns it:

| Expected document | First place to check |
|---|---|
| `A…`, `S…`, or first `H…` PO | VTiger Container Control creation workflow and its latest webhook result. |
| `H…-2`, `H…-3` recurring hire PO | Container Control Acquisition/Status, Collection Date, the 30-day due period, and the first-of-month schedule log. |
| Initial storage invoice, JD and GD | Storage activation webhook, live storage-stage wording, Date In, customer, container and allocated transport supplier. |
| Later storage invoice and GD | Active storage event’s next billing date and the first-of-month schedule log. |
| Storage final invoice/GD | Finalisation webhook, Date Out or Full Container Delivery Date, billed-through date and existing Draft statuses. |
| `INV-<Deal>` main invoice | VTiger main-invoice workflow, linked Quote and invoice-number collision result. |
| `INV-<Deal>-D` deposit | Deposit Status, Deposit Amount Required and prior deposit invoice. |
| Extra-hire suffix invoice | Hire Duration, Hire End Date, container type/number and the extension-period tracker. |
| `I<Deal>` warranty PO or warranty invoice line | Added Services selection, main-invoice status and warranty tracker/audit entry. |

## References

[1]: /home/ubuntu/supplier-sourcing-crm/server/vtigerCcWebhook.ts "Container Control purchase-order creation workflow"
[2]: /home/ubuntu/supplier-sourcing-crm/server/forHireMonthlyPo.ts "Recurring For Hire purchase-order workflow"
[3]: /home/ubuntu/supplier-sourcing-crm/server/hirePoPeriods.ts "Container hire periods and Xero line-item rules"
[4]: /home/ubuntu/supplier-sourcing-crm/server/vtigerStorageWebhook.ts "Loaded-container storage webhook workflow"
[5]: /home/ubuntu/supplier-sourcing-crm/server/storageFinancials.ts "Storage invoices, purchase orders, recurrence, and finalisation rules"
[6]: /home/ubuntu/supplier-sourcing-crm/server/storageMonthlyBilling.ts "Monthly loaded-container storage billing schedule handler"
[7]: /home/ubuntu/supplier-sourcing-crm/server/vtigerCustomerInvoiceWebhook.ts "Main, deposit, final-weight, extra-hire, and warranty invoice workflows"
[8]: /home/ubuntu/supplier-sourcing-crm/server/warrantyPurchaseOrders.ts "Matching Aviso warranty purchase-order workflow"
[9]: /home/ubuntu/supplier-sourcing-crm/references/make-customer-invoice-blueprints-inventory.md "Customer invoice blueprint and CRM migration inventory"
[10]: /home/ubuntu/supplier-sourcing-crm/.manus-logs/financial-heartbeats.txt "Live project schedule inventory retrieved 25 September 2026"
