# Financial Operations — Go-Live Gate Checklist

**Application:** ContainerZone Supplier Invoice Manager — AP Management  
**Scope:** Financial Operations writer preparation only  
**Current state:** The Xero **Draft-only** writer is prepared but **disabled and not routable**. No financial document will be created until the required evidence and a new document-specific approval are supplied.

> **Important:** Complete the steps below per financial family. Do not disable an existing Operations/VTiger/Make writer, create a schedule, or activate a financial writer merely because a release manifest becomes green. Those are separate, controlled changes after a document-specific approval.

---

## 1. Work in the right workspace

1. Sign in as an **Administrator**.
2. Open **Financial Operations** in the sidebar.
3. The page has one parent workspace and four numbered areas:
   - **1. Dashboard** — status only.
   - **2. Document Operations** — proposed PO/invoice records and trigger runs.
   - **3. Review & Evidence** — Candidate Roster and Shadow Test Register.
   - **4. Controls** — Automation Settings, Cutover Control Centre and **All-Family Release**.

The four gates below live principally in **Review & Evidence** and **Controls**.

---

## 2. Gate A — Legacy-writer handoff

### Purpose

This prevents two systems from creating the same Xero document. The AP Management writer cannot be considered for a family until the existing writer is precisely identified and a reversible handoff is documented.

A **legacy writer** may be an Operations automation, VTiger workflow, Make scenario, API job, manual recurring process, or an existing Heartbeat schedule. Do not guess its identity.

### Collect this information for each family

| Required field | What to provide | Example format |
|---|---|---|
| Financial family | The exact family in the All-Family Release matrix | `Recurring For Hire` |
| Existing writer identifier | Exact scenario/workflow/job/schedule name or URL/ID | `Make scenario 12345 — Create monthly container hire invoice` |
| Current owner | Person/team responsible for that writer | `Operations Automation — Ashish Gupta` |
| Trigger | What starts it today | `Daily scan of on-hire containers at 07:00 AEST` |
| Scope | What documents it can create or amend | `Creates HC<container>-<suffix> customer Draft invoices only` |
| Disable action | Exact future change—not a vague statement | `Turn scenario 12345 OFF after AP Draft H1860 is verified; retain scenario history and connection.` |
| Rollback action | Exact reversible response | `Turn scenario 12345 ON; pause AP family route; reconcile H1860 before any retry.` |
| Handoff owner and timing | Who performs it and during what window | `Ashish, 12 Oct 2026 19:00–20:00 AEST` |

### Record it in the application

1. Go to **Financial Operations → 4. Controls → All-Family Release**.
2. Select **Prepare fresh release manifest**. You may optionally enter the proposed maintenance window and release owner.
   - This runs only a current Xero **GET** check and a VTiger read check; it does not write to either system.
3. In the **All-family release matrix**, find the applicable family.
4. Click **Record inventory** for that family.
5. Enter:
   - **Exact writer / schedule identifier**
   - **Current owner**
   - **Approved disable action (documentation only)**
6. Choose **Record local handoff evidence**.

This only records evidence inside AP Management. It does **not** disable the legacy writer.

### Completion condition

Each future activated family needs its own inventory entry. The current family row must show the writer identifier, owner and disable action, and the release manifest needs to be refreshed afterward.

---

## 3. Gate B — Storage GST decisions

### Why this is a separate decision

The writer already keeps **purchase-order lines GST-exclusive**. The outstanding question is the correct GST treatment for the **customer-facing storage documents**. This must be set before any storage family can produce a Draft customer invoice; the system must not infer it from a historical document.

The decision applies to these storage-related families:

1. **Origin Storage Activation** — customer storage invoice plus `JD<Deal>` and `GD<Deal>` POs.
2. **Destination Storage Activation** — customer storage invoice plus `JD<Deal>` and `GD<Deal>` POs.
3. **Recurring Storage** — recurring customer storage invoice plus `GD<Deal>` PO; no recurring `JD` PO.
4. **Storage Finalisation / Recovery** — changes only an existing **Draft** storage customer invoice.

### Obtain one written tax instruction

Ask the finance/tax owner to complete the following for **each storage charge type** (origin, destination, recurring, finalisation/recovery adjustment):

| Decision | Required answer |
|---|---|
| Is the charge taxable? | `GST 10%` or `GST-free` or another explicitly named treatment |
| Are entered rates exclusive or inclusive of GST? | One choice only |
| Xero customer-invoice tax treatment | Exact Xero TaxType / rate to use |
| Xero account code | Exact revenue account code and name |
| Xero item code, if required | Exact item code, or state that no item is used |
| Calculation basis | Daily, weekly, monthly, fixed fee, prorated period, recovery adjustment, etc. |
| Rounding rule | For example: round each line to two decimals before invoice total |
| Credit/adjustment handling | Whether negative Draft adjustments are permitted and under what condition |
| Evidence owner | Finance/tax approver, date and written reference |

### Recommended decision wording

> “For [charge type], rates are [exclusive/inclusive] of GST. Use Xero [TaxType] at [rate]%, revenue account [code — name], and [item code/no item]. Calculate [basis] and round [rule]. This applies from [effective date]. Approved by [name, role, date].”

### How it is applied

1. Send the completed written GST matrix to the AP/IT owner.
2. The AP administrator records the approved **non-secret rule configuration** in **Financial Operations → 4. Controls → Automation Settings** only after the mapping is reviewed.
3. For each storage family, run a new named-source **shadow test** after the configuration update.
4. Check that the proposed Draft customer invoice shows the correct **net amount, GST amount, gross amount, account code, item code and TaxType**.
5. An administrator confirms the clean test with a factual comment.
6. Prepare a fresh All-Family Release manifest.

### Completion condition

A storage family is not ready merely because a GST value is entered. It needs a written finance/tax decision, an updated non-secret rule mapping, a current named-source shadow test, and an administrator’s evidence review.

---

## 4. Gate C — Schedule and event details

### First classify the family

There are two patterns:

| Pattern | Financial families | What is needed |
|---|---|---|
| **Event-driven** | Initial Container Control, Storage Activation, Storage Finalisation/Recovery, Main Customer Invoice, Deposit, Final Weight, Extra Hire, Warranty/Aviso | The precise source event, eligibility condition and source identifier; **no recurring schedule** should be created. |
| **Recurring** | Recurring For Hire and Recurring Storage | An approved cadence and operational window, plus a documented backstop for missed runs. |

### Provide a schedule/event specification

Use one row per family with these fields:

| Required field | Event-driven example | Recurring example |
|---|---|---|
| Family | `Main Customer Invoice` | `Recurring For Hire` |
| Trigger source | `VTiger deal reaches [exact stage/event]` | `Approved on-hire container eligibility review` |
| Eligible record condition | `Deal is current, customer is resolved, no exact INV-<deal> Draft/non-Draft duplicate` | `Container remains on hire at billing cut-off; no matching HC<container>-<suffix> document` |
| Time zone | `AEST/AEDT` | `AEST/AEDT` |
| Cadence | `Event-driven — none` | Exact business cadence, e.g. `monthly on the first business day at 07:00 AEST` |
| Blackout/cut-off | `Do not run when source is incomplete` | `No run during month-end close; cut-off 18:00 on prior business day` |
| Late/missed-run policy | `Manual review only` | `Do not catch up automatically; create a reconciliation-required item for AP review` |
| Duplicate/idempotency basis | Exact source ID + document family + billing period | Exact container/deal + billing period + family |
| Alert recipient/owner | Named AP/IT owner | Named AP/IT owner |
| Rollback | Pause future event route; do not amend Xero document | Pause schedule; do not replay automatically; reconcile the named Draft first |

### Important schedule rules

1. **Do not create a schedule for an event-driven family.**
2. For a recurring family, provide the business wording first; AP/IT will convert it to the Heartbeat six-field cron expression after reviewing the time zone and daylight-saving behavior.
3. A recurring job must run through the approved `/api/scheduled/...` Heartbeat pattern, not an in-process timer.
4. A missed run must create a review/reconciliation task—not silently bulk-create catch-up documents.
5. The schedule is created **only after** the corresponding family has passed its source, GST (where relevant), legacy-handoff and document-specific approval gates.

### Completion condition

The All-Family Release matrix needs the family’s intended cadence or event-only state, but no Heartbeat job is created at this stage. The final approval for a recurring family must name the exact schedule and first eligible billing period.

---

## 5. Gate D — Document-specific approval

### Why broad approval is not enough

“Make Financial Operations live” is not a sufficient authorization because it would not identify the Xero record, amount, counterparty or operational handoff. Approval is required **per named source and proposed Draft document**.

### Complete the evidence first

For the proposed document:

1. Go to **Financial Operations → 3. Review & Evidence → Candidate Roster**.
2. Add the exact business number and correct workflow family.
3. Resolve it using the **VTiger read-only finder**. It must return one accepted, exact candidate; ambiguous or missing candidates stay blocked.
4. Go to **Shadow Test Register** and run the evidence-only test against that roster entry.
5. Review:
   - source record number and current fields;
   - proposed Xero document number(s);
   - counterparty/contact;
   - line descriptions, quantities and unit amounts;
   - net, GST and gross totals;
   - account code, item code and TaxType;
   - expected Draft-only action;
   - Xero duplicate/status preflight result;
   - idempotency/retry conditions.
6. As an administrator, open the test and select **Confirm** only if the evidence exactly matches the intended commercial outcome. Enter a factual review note.
7. In **4. Controls → Cutover Control Centre**, prepare the family cutover pack from the confirmed evidence. Do not activate it.
8. In **All-Family Release**, refresh the manifest so it captures current evidence and the legacy-writer inventory.

### Approval request template

Use this exact level of detail in the final request:

> **Request: one Draft-only Xero financial write**  
> **Family:** [family name]  
> **Source:** [VTiger/Container Control exact record ID and business number]  
> **Action:** [create Draft PO / create Draft ACCREC invoice / update this exact Draft only]  
> **Proposed Xero document number(s):** [number(s)]  
> **Counterparty:** [Xero contact]  
> **Lines and amounts:** Net $[x], GST $[x], Gross $[x]; include line summary  
> **GST/account/item rule:** [approved mapping and reference]  
> **Current Xero preflight:** [no duplicate / exact existing Draft ID and status]  
> **Legacy handoff:** [identifier, owner, exact disable action and timing]  
> **Schedule/event:** [event-only OR exact first schedule and time zone]  
> **Maintenance window:** [start–end with time zone]  
> **Rollback:** [pause AP family, re-enable named legacy writer if needed, reconcile named Draft; no blind retry]  
> **Approval requested:** Authorise this one Draft-only action. No approval, payment, void, deletion or non-Draft amendment is included.

### Completion condition

The approver must explicitly confirm the **specific document and action**, not merely a family. The approval reference is retained in the writer execution ledger before any future Xero call.

---

## 6. Safe order of completion

Use this sequence for **one family at a time**:

1. Verify **Automation Settings** shows passing Xero `CONTAINERZONE` and VTiger read-only checks.
2. Document the **legacy writer handoff** in All-Family Release.
3. Obtain and record the **GST decision** if the family has a storage customer-invoice component.
4. Record the **event or recurring schedule specification**. Do not create a job yet.
5. Add and resolve one **Candidate Roster** source.
6. Run, review and confirm one **Shadow Test**.
7. Prepare the family **Cutover Pack** and refresh the **All-Family Release** manifest.
8. Submit the **document-specific approval request** using the template above.
9. Only after approval, perform a separately controlled release for that family and the named Draft document.
10. Verify the exact Draft in Xero, record the result in the execution ledger, then complete the legacy handoff only as approved.

> A 502/503/504 from Xero is never a reason to press send repeatedly. The prepared writer retains a deterministic idempotency key, makes one limited retry, then requires read-back reconciliation of the named Draft before any further action.

---

## 7. What to send next

To begin safely, send the following for the **first** family you want to activate:

1. Family name.
2. Exact named source record/business number.
3. Legacy writer identifier, owner and approved future disable action.
4. Storage GST decision, if applicable.
5. Event details or recurring schedule specification.
6. Proposed Xero Draft number(s), counterparty and amounts.
7. Named approver, maintenance window and rollback instruction.

This starts with evidence preparation and does **not** enable a writer, change a schedule or create a Xero document.
