# Financial Operations — Detailed Test Guide

**Application:** ContainerZone Supplier Invoice Manager  
**Scope:** Financial Operations workspace only  
**Current safety mode:** **Shadow / no Xero writes**  
**Current automated validation:** **42 test files, 245 tests passing**, TypeScript clean, production build successful.

> **Important:** The Financial Operations workspace is a migration and evidence workbench. It can read named source information, calculate proposed financial documents, and persist AP-side ledger/evidence rows. It **cannot** create, update, authorise, email, pay, void, or delete a Xero document. It also cannot register or enable a financial schedule, change a VTiger workflow URL, or alter an existing Operations writer.

---

## 1. Before starting

### 1.1 Publish and access

1. Publish the latest approved application checkpoint before performing browser-based testing.
2. Sign in using an **administrator** account for the full guide. Staff can inspect the non-admin sections but cannot perform the evidence, integration, configuration, or cutover-control tests.
3. In the sidebar, open **Financial Operations**.
4. Confirm the blue banner says:

> **Financial write lock is active.** Every result below is an AP-side shadow calculation and audit record.

If that banner is not present, **stop**; do not test from an older build.

### 1.2 What each test can and cannot change

| Test area | May create/change | Cannot change |
|---|---|---|
| Synthetic dry-run | Local financial run, proposed-document intent, local exception | Xero, VTiger, Operations, schedules |
| Current VTiger shadow test | Local evidence, run, intents and exceptions; read-only VTiger/Xero evidence | VTiger record, Xero document, workflow URL, schedule |
| Candidate Finder/Roster | Local candidate/audit/roster data; exact VTiger read | VTiger records, Xero documents |
| Historical Preview | Browser-only preview result; Xero GET reads | Stored historical import, Xero documents |
| Automation Settings | Non-secret local configuration and immutable local audit | OAuth tokens, access keys, secrets, schedule state, Xero documents |
| Cutover Control Centre | Local control/pack/audit evidence | Xero transport, any live enablement, schedules, Operations/VTiger writers |

### 1.3 Roles

| Role | Financial Operations access |
|---|---|
| **Staff** | Overview, PO Operations, Customer Invoices, Trigger Runs, Exceptions and Schedules. Can inspect evidence but cannot create tests, alter mappings or prepare cutover packs. |
| **Administrator** | All staff views plus Candidate Roster, Candidate Finder, Shadow Test Register, Historical Preview, Automation Settings and Cutover Control Centre. |

### 1.4 Key terms

| Term | Meaning |
|---|---|
| **Workflow run** | A stored shadow evaluation of source data for one financial workflow family. |
| **Document intent** | A proposed PO or customer invoice calculated by the evaluator. It is not a Xero document. |
| **Shadow test** | Evidence comparing expected business facts, live named VTiger source data, the AP calculation and GET-only Xero preflight checks. |
| **Candidate Roster** | An explicit list of approved named Deals or Container Controls that can be read exactly; it does not browse all VTiger data. |
| **Cutover pack** | A locally stored, disabled planning pack built from a confirmed shadow test. It is not a live approval and sends no request to Xero. |

---

## 2. Navigation and role-boundary test

This confirms that every financial feature is under the single parent workspace and that staff do not receive admin controls.

### Administrator test

1. Open **Financial Operations**.
2. Confirm the parent areas appear in this order:
   1. **Dashboard**
   2. **Document Operations**
   3. **Review & Evidence**
   4. **Controls**
3. Confirm these child tabs appear:

| Parent area | Child tabs |
|---|---|
| Dashboard | Overview |
| Document Operations | PO Operations, Customer Invoices, Trigger Runs |
| Review & Evidence | Exceptions, Candidate Roster, Shadow Test Register, Historical Preview |
| Controls | Schedules, Automation Settings, Cutover Control Centre |

4. Switch between each parent area and child tab.
5. Confirm that changing tabs does not create a run, intent, schedule, document, or alert.

**Pass condition:** all tabs render under the single Financial Operations sidebar entry; there are no separate browser routes for individual workflow families.

### Staff-boundary test

1. Sign in as a staff user.
2. Open **Financial Operations**.
3. Confirm the staff user can view:
   - Overview
   - PO Operations
   - Customer Invoices
   - Trigger Runs
   - Exceptions
   - Schedules
4. Confirm the staff user **cannot see**:
   - Candidate Roster
   - Shadow Test Register
   - Historical Preview
   - Automation Settings
   - Cutover Control Centre
   - **New dry-run** buttons

**Pass condition:** staff visibility is read-oriented only. No admin-only button should be visible or callable.

---

## 3. Overview dashboard test

1. Select **1. Dashboard → Overview**.
2. Check the six summary cards:
   - Trigger runs today
   - Proposed documents
   - Confirmed Draft documents
   - Failed or held
   - Open exceptions
   - Next recurring / storage
3. Select **Refresh** in the page header.
4. Confirm the card values and tables refresh without a browser error.
5. Review **Phase-one coverage**. It should list all ten workflow families.
6. Review **Current controls**. It must state that VTiger is isolated, Xero proposals are not written, and schedules are disabled.

**Pass condition:** metrics correspond to local ledger/evidence data only. “Confirmed Draft documents” means a locally confirmed evidence state, **not** a newly created Xero Draft.

---

## 4. Document Operations tests

### 4.1 PO Operations

1. Select **2. Document Operations → PO Operations**.
2. If the table is empty, first create a safe synthetic preview as described in [Section 8.1](#81-synthetic-evaluator-preview).
3. In the filter box, search using one of:
   - proposed PO number,
   - supplier name, or
   - document type such as `initial_for_hire`, `jd_transport`, or `aviso_warranty`.
4. Verify the table columns:
   - PO/family
   - Supplier
   - Account
   - Proposed total
   - Action
   - Validation
5. Open a run from **Trigger Runs** and compare the intent count and total to the PO table.

**Expected:** records are labelled as a proposed `create_draft`, `update_draft`, `validate_only`, or `hold` action. These labels describe future intent only.

**Safety check:** There is deliberately no **Create PO**, **Push to Xero**, **Approve**, or **Retry live** button in this screen.

### 4.2 Customer Invoices

1. Select **2. Document Operations → Customer Invoices**.
2. Filter by proposed invoice number, customer name, or invoice type.
3. Verify the columns:
   - Invoice/type
   - Customer
   - GST treatment
   - Proposed total
   - Draft eligibility
4. Compare one record against its associated run and shadow evidence.
5. Note any `warning`, `held`, or `PENDING_CONFIGURATION` GST state.

**Expected:** customer invoices remain proposed only. A valid result is **not** a Xero invoice.

**Safety check:** storage-related customer proposals intentionally show `PENDING_CONFIGURATION` until GST/numbering rules are formally confirmed. They cannot be turned into a live request from this screen.

### 4.3 Trigger Runs

1. Select **2. Document Operations → Trigger Runs**.
2. Confirm each run shows workflow family, source, outcome, proposed document count, exception count, and **Shadow mode — no Xero writes**.
3. Create one safe synthetic preview (Section 8.1), then return here.
4. Confirm a new row appears with a `manual` or `re_evaluation` trigger type.
5. Confirm the corresponding proposed intent appears in either PO Operations or Customer Invoices.

**Expected:** each run is an auditable local calculation. Re-running with new source data creates a new shadow run; it is not a live retry.

---

## 5. Exceptions and review queue test

A clean test includes an intentional missing-data case so that the exception queue can be checked without using production financial data.

1. Select **3. Review & Evidence → Exceptions**.
2. If no exception is present, create a synthetic preview with incomplete source data—e.g. use the default example for **Main customer invoice** without `quoteServiceLines`.
3. Return to Exceptions and find an entry such as **Missing Quote Service lines**, **Missing supplier**, or another validation error.
4. Select **Review**.
5. Verify that the dialog displays:
   - exception code,
   - severity and status,
   - stored details,
   - review history.
6. As an administrator, type a factual comment such as `Synthetic test only — missing source data expected; no external action required.`
7. Select **Add comment** and confirm it appears in the review history.
8. Select **Mark resolved** only when the local exception is genuinely dealt with or when you are closing a synthetic test record.

**Expected:** resolving changes the local exception ledger only. It does **not** retry a workflow, create a document, or contact Xero/VTiger.

---

## 6. Schedule visibility test

1. Select **4. Controls → Schedules**.
2. Confirm only the two planned recurring families appear:
   - Recurring For Hire
   - Recurring Storage
3. Confirm **Task ID** is `None` unless a non-live planning record was documented.
4. Confirm **State** is **Disabled** or **Blocked**, never Enabled.
5. Confirm the explanatory text says a target schedule cannot be created or enabled from this screen.

**Pass condition:** the screen is visibility-only. No **Enable**, **Create schedule**, **Run now**, or cron execution control is available.

---

## 7. Candidate discovery and Candidate Roster tests

> Use a **named source only**. Do not attempt broad VTiger searching. The verified historical Deal `D702903` can be used to test exact Deal discovery, but it is **not** a substitute for a named current **For Hire Container Control** required for the Initial For Hire workflow test.

### 7.1 Candidate Finder — exact lookup

1. Select **3. Review & Evidence → Candidate Roster**.
2. In **VTiger Candidate Finder**, select either **Deal** or **Container Control**.
3. Enter one exact business number.
   - Safe known Deal discovery example: `D702903`.
4. Select an intended workflow family.
5. Select **Find exact candidate**.
6. Verify one of the outcomes:

| Outcome | Meaning | Correct next action |
|---|---|---|
| **Found** | Exactly one current record matched the configured business field | Add the reference to Candidate Roster for the approved workflow/branch; do not create evidence directly from the finder. |
| **Not found** | No exact record matched | Correct the business number or record a needs-data condition. |
| **Ambiguous** | More than one record matched | Do not choose one manually; resolve the source data first. |
| **Blocked** | Credentials/configuration/read access prevents a safe lookup | Use Automation Settings to diagnose read-only readiness. |

7. Confirm a new **Candidate lookup audit** row appears with business number, outcome, candidate IDs, and timestamp.

**Safety check:** Candidate Finder uses VTiger form login only to establish a legacy API session, then performs exact reads. It never creates, edits, or deletes a VTiger record.

### 7.2 Add a Candidate Roster row

1. In the **Candidate Roster** card, choose the source category.
2. Enter the exact business reference.
3. Select the intended workflow family.
4. Enter a specific business branch, for example `Initial For Hire Container Control`.
5. Assign an optional owner and reviewer.
6. Add an optional business note describing the expected source facts.
7. Select **Add to Candidate Roster**.
8. Confirm the row is shown with a `draft` discovery status.

**Pass condition:** only a local, explicit test-plan row is created. The roster does not retrieve VTiger until **Resolve exact record** is selected.

### 7.3 Resolve a Candidate Roster row

1. In the saved roster row, select **Resolve exact record**.
2. Confirm the outcome becomes **Found**, **Not Found**, **Ambiguous**, or **Blocked**.
3. If **Found**, confirm a VTiger record ID appears.
4. If the outcome is not Found, do not proceed to shadow evidence.
5. Use **Record needs data** if a specific source fact or business reference is unavailable. Enter a useful explanation of at least eight characters.

**Expected:** the row captures discovery state and audit evidence. No Xero or VTiger record changes.

### 7.4 Run roster-based shadow evidence

**Prerequisites**

- The roster row must be **Found** with exactly one VTiger record ID.
- The selected record must still resolve uniquely when revalidated.
- Fresh read-only Xero and VTiger readiness checks must pass.
- The workflow/branch/source category shown on the roster must match the stored row exactly.

Steps:

1. Select **Run shadow evidence** on a Found Candidate Roster row.
2. Wait for the fresh integration readiness checks and exact candidate revalidation.
3. Open **Shadow Test Register**.
4. Confirm a reviewer-held evidence record is created, linked to a workflow run and intent IDs.

**Expected:** the test is normally held for administrator review even if all calculated facts match. It is not automatically marked as a clean business pass.

---

## 8. Shadow Test Register tests

### 8.1 Synthetic evaluator preview

Use this for safely checking calculations and table population without reading a production VTiger record.

1. Select **3. Review & Evidence → Shadow Test Register**.
2. Select **New read-only test**.
3. Choose a workflow family—for a simple test, select **Main customer invoice**.
4. Expand **Optional synthetic evaluator preview**.
5. Replace the source JSON with a controlled example such as:

```json
{
  "dealNumber": "D700001",
  "customerOrganisationName": "Example Customer Pty Ltd",
  "quoteNumber": "Q-700001",
  "issueDate": "2026-10-01",
  "dueDate": "2026-10-15",
  "quoteServiceLines": [
    {
      "itemCode": "TEST-SERVICE",
      "description": "Synthetic test service",
      "quantity": 1,
      "amountExGst": 100,
      "taxRate": 10
    }
  ]
}
```

6. Select **Preview synthetic payload**.
7. Confirm a shadow run and a proposed `INV-700001` customer-invoice intent appear.
8. Verify the expected calculated result is subtotal **$100.00**, GST **$10.00**, total **$110.00**, subject to configured rules.
9. Confirm no Xero document appears in Xero.

**Purpose:** validates evaluator calculation, GST handling, idempotent ledger creation, Trigger Runs, Customer Invoices and exception recording without touching external systems.

### 8.2 Real named VTiger shadow test

Use this only with an approved exact candidate and expected business facts.

1. Open **New read-only test**.
2. Select the correct workflow family and branch.
3. Enter the named Deal/Container Control reference.
4. Enter the exact VTiger record ID in `moduleId x recordId` format, such as `5x486152` only when it is the actual candidate record for the intended workflow.
5. Optionally enter known existing Xero-style references to test duplicate/preflight handling.
6. Enter the expected-result JSON. Include only facts you can substantiate, for example:

```json
{
  "proposedDocumentNumbers": ["H123456"],
  "accountCodes": ["312"],
  "itemCodes": ["HC 20"],
  "gstTreatments": ["GST_EXCLUSIVE"],
  "totals": [132]
}
```

7. Select **Run read-only shadow test**.
8. Review the result in Shadow Test Register.

| Test outcome | Meaning | Next action |
|---|---|---|
| **Needs data** | Expected facts or usable source values are missing | Record/obtain the missing fact; do not guess. |
| **Blocked** | Xero/VTiger read-only check or preflight failed | Correct integration readiness; do not force the test. |
| **Held** | Duplicate/non-Draft/validation condition or clean evidence awaiting review | Inspect details and resolve the business condition or review it. |
| **Failed** | Supplied expected facts differ from AP calculation | Compare source/rules/expected facts; correct the evidence, not the result. |
| **Review-eligible held** | All deterministic comparisons match but an administrator must decide | Use the Review dialog and record a meaningful confirmation or rejection. |

### 8.3 Review, confirm or reject evidence

1. In **Shadow Test Register**, locate the test and select **Review**.
2. Compare all four panels:
   - expected business-rule result,
   - actual AP proposal/source values,
   - field-level comparison,
   - GET-only Xero preflight.
3. If values match and no preflight warning exists, enter a meaningful reviewer comment of at least six characters, e.g.:

> Confirmed against named current source, frozen AP rules and GET-only Xero preflight. Draft-only proposal remains disabled.

4. Select **Confirm evidence**.
5. If any difference or uncertainty remains, enter a reason and select **Reject evidence**.

**Pass condition:** confirmation changes local evidence review state only. It does not permit or trigger a live Xero action.

### 8.4 Record a needs-data test deliberately

1. Select **Record needs-data**.
2. Select workflow family and branch.
3. Enter a named source if known.
4. Describe the exact missing condition—e.g. `Current For Hire Container Control number and approved expected hire-rate facts are not supplied.`
5. Select **Record needs-data evidence**.
6. Verify the new record has status **Needs Data**.

**Purpose:** records a real blocker without inventing data or querying an arbitrary VTiger record.

### 8.5 Export evidence CSV

1. In Shadow Test Register, select **Export CSV**.
2. Open the downloaded CSV.
3. Verify it contains test ID, workflow, branch, source, status, expected/actual result, differences, Xero preflight, explanation, run ID, intent IDs and exception IDs.

**Expected:** the export contains local evidence only. It does not include OAuth tokens, VTiger access keys or webhook secrets.

---

## 9. Historical Preview test

1. Select **3. Review & Evidence → Historical Preview**.
2. Enter up to 50 known references separated by commas or new lines, for example:

```text
A1860
H1860
INV-702900
```

3. Select **Run read-only preview**.
4. Review each row for:
   - inferred document family,
   - reconciliation state,
   - Xero summary/document ID if found,
   - party and document status,
   - explanatory note.
5. Try a deliberately unknown, non-sensitive reference to confirm it returns a no-match/review state.

**Pass condition:** this is a bounded GET-only check. It does not bulk import history, persist historical document snapshots, attach files or change Xero.

---

## 10. Automation Settings test

> Do not paste credentials, tokens or webhook secrets into this application. This screen is intentionally non-secret.

### 10.1 Read-only connection checks

1. Select **4. Controls → Automation Settings**.
2. Confirm the top mode is **SHADOW / NO WRITE**.
3. Under **VTiger source**, select **Test read-only connection**.
4. Confirm the result is stored in the non-secret integration audit.
5. Under **Xero AP Management tenant**, select **Test read-only connection**.
6. Confirm the result identifies the expected **CONTAINERZONE** tenant and shows only non-secret status/expiry information.
7. Review the readiness cards and latest/last-successful checks.

**Expected external activity:**

- VTiger uses its documented challenge plus form-login session, followed by exact GET reads when requested. The form-login POST creates no CRM record.
- Xero performs a GET-only tenant/organisation validation.

**Pass condition:** a passing result means connectivity/readiness only. It does not mean live financial writing is enabled.

### 10.2 Webhook readiness display

1. In Automation Settings, review **Authenticated shadow webhook**.
2. Confirm only the endpoint path and configuration presence are shown.
3. Confirm the secret itself is never displayed.
4. Confirm accepted modes are `shadow` and `dry_run` only.

### 10.3 Non-secret configuration audit

Use a harmless, unused key so you do not alter active financial rules during a test.

1. Set **Configuration key** to a safe test value, for example:

```text
financial-operations.test-2026-09-27
```

2. Set **Description** to `Safe local UI configuration-audit test`.
3. Set **JSON configuration value** to:

```json
{
  "purpose": "UI audit test",
  "xeroWritePermitted": false
}
```

4. Select **Save non-secret configuration**.
5. Verify it appears in **Active configuration**.
6. Verify the change appears in **Immutable configuration audit** with the logged-in user and time.

**Do not use** `financial-automation.rules` for a casual test. That key changes the non-secret evaluation rules used by later shadow tests. If it must be changed, document the original value and restore it precisely after the controlled test.

---

## 11. Optional authenticated shadow webhook test (AP/IT only)

This is not required for ordinary UI testing. Use it only if AP/IT controls the configured `FINANCIAL_SHADOW_WEBHOOK_SECRET` and wants to test inbound shadow-event handling.

1. Do **not** share the secret in chat, email, screenshots or source control.
2. Use a disposable synthetic source payload, not an unapproved live CRM record.
3. Send an authenticated request to:

```text
POST /api/financial-workflows/shadow-events
```

4. Include the header `x-financial-shadow-secret` using the securely held secret.
5. Use a body with `mode` set to `shadow` or `dry_run`, a valid workflow type, and a source-data object.
6. Confirm the response contains:
   - `mode: "shadow"`
   - `xeroWritePermitted: false`
   - a local `runId`
   - proposed document numbers and issue count.
7. Confirm the resulting run appears in Trigger Runs.

**Expected:** the endpoint rejects missing/incorrect secrets, unsupported workflow types and missing source data. It has no live mode and cannot mutate Xero, VTiger workflow configuration or schedules.

---

## 12. Cutover Control Centre test

1. Select **4. Controls → Cutover Control Centre**.
2. Confirm the red banner says the **production writer is disabled**.
3. Confirm the three protections are described:
   - global lock,
   - existing writer protection,
   - Xero action boundary.
4. Review the **Per-family cutover controls** table.
5. Confirm every family is **Shadow** or **Live Ready Disabled**, and that every safety state reads **Write locked** or **Blocked**.
6. Confirm no family has a clickable live-enable control.
7. Confirm the table does not claim a legacy writer identifier unless one has been explicitly documented. It must never guess one.

### 12.1 Prepare a disabled cutover pack

Only perform this after a clean shadow test has been confirmed by an administrator.

1. In Cutover Control Centre, locate **Prepare a disabled cutover pack**.
2. Select a clean, confirmed test from the dropdown.
3. If known, type the exact existing Operations writer or schedule identifier. Leave it blank rather than guessing.
4. Select **Prepare disabled pack**.
5. Verify the success message states that no Xero request was sent.
6. Verify a local pack appears in **Prepared cutover packs** with:
   - workflow family,
   - shadow test ID,
   - named source,
   - intent IDs,
   - `awaiting_approval` state,
   - next approval wording.
7. Verify the local **Cutover planning audit** receives a new `prepared` entry.

**Pass condition:** a pack is planning evidence only. It does not alter an existing writer, enable any family, create a schedule, or transmit a Draft payload.

### 12.2 Test the hard writer lock conceptually

The UI deliberately has no action for this. The application-level safeguard is tested automatically:

- a valid Draft payload can be **prepared** deterministically for review;
- any attempt to call the writer execution seam throws `FinancialWriteDisabledError` before a transport can run;
- the production writer module imports no HTTP/Xero client;
- no registered live financial route exists.

**Expected:** there is no browser action that can override this lock.

---

## 13. All ten workflow-family coverage guide

Use synthetic preview first. Use a real named VTiger record only after it is approved in Candidate Roster and expected facts are known.

| Workflow family | Main proposed output to verify | Key safe test facts | Important hold/warning condition |
|---|---|---|---|
| Container Control acquisition | `A<control>` asset PO; `S<control>` customer-sale PO; `H<control>` initial hire PO when For Hire | Control number, 20/40-foot type, Request status, collection date, suppliers, costs | Missing supplier/hire supplier/cost or unsupported size holds proposal |
| Recurring For Hire | `HC<control>-2` and later suffix PO | For Hire acquisition, On Hire/Idle status, container number, daily rate, supplier, period | Request/Dehired/Ready status or missing Xero purchase-side rate holds it |
| Storage activation | Customer storage proposal plus `JD<deal>` transport PO and `GD<deal>` storage PO | Deal number, 20/40 type, container, Date In, storage stage, customer and suppliers | Customer storage GST/numbering is intentionally pending configuration; missing parties/rates hold components |
| Recurring storage | Recurring customer storage proposal plus `GD<deal>` storage PO | Same core storage facts and recurring period | Still a shadow proposal; GST/numbering must be configured before any future cutover |
| Storage finalisation | Update-Draft storage customer invoice intent | Storage billing event, final weeks, source document statuses, Date Out | Non-Draft document or recovery request produces a hold; non-Draft documents are never amended |
| Main customer invoice | `INV-<deal>` customer invoice | Deal number, customer, quote number, quote-service lines, dates | Missing customer/quote lines holds it |
| Deposit invoice | `INV-<deal>-D` deposit invoice | Positive deposit amount, Pending/blank deposit status, customer | Non-Draft main invoice produces warning/held deduction logic; no non-Draft amendment |
| Final weight adjustment | Update-Draft `INV-<deal>` intent | Weight direction, Draft main invoice, positive overweight amount or underweight due date | Only Draft main invoice is editable; invalid direction or missing amount/date holds it |
| Extra Hire | Next free `INV-<deal>-n` invoice | 30-day duration, current hire-end date, 20/40 type, container, customer | Wrong duration, missing date/customer/type/container holds it |
| Warranty reconciliation | Customer warranty invoice/update plus `I<deal>` Aviso warranty PO | Added Services value, mapping item/description/premium, customer, main invoice status | Incomplete mapping holds it; non-Draft main invoice uses a separate suffix proposal instead of replacement |

### Recommended testing order

1. **Synthetic Main Customer Invoice** — simplest end-to-end calculation.
2. **Synthetic Container Control Acquisition** — validates PO generation and For Hire logic.
3. **Synthetic Storage Activation** — validates one customer proposal plus two PO proposals and expected warnings.
4. **Synthetic Deposit / Final Weight / Extra Hire / Warranty** — validates special status and suffix rules.
5. **Named current Initial For Hire Container Control** — first controlled roster-based source test after the business supplies a valid candidate.
6. Complete a reviewer decision before preparing any disabled cutover pack.

---

## 14. Regression-test commands for technical users

Run these only in the AP Management project development environment:

```bash
cd /home/ubuntu/ap_invoice_manager
npx tsc --noEmit
pnpm test
pnpm build
```

Expected at the current checkpoint:

```text
42 test files passed
245 tests passed
```

The cutover-specific tests include:

```bash
pnpm vitest run \
  server/financialProductionWriter.test.ts \
  server/financialWorkflowRouter.test.ts \
  server/financialOperationsNavigation.test.ts
```

They verify the Draft payload shape, deterministic idempotency, rejected writer execution, cutover-pack eligibility, role enforcement and parent-tab boundaries.

---

## 15. Final acceptance checklist

Mark the following only after you have completed the relevant tests:

| Item | Expected result | Complete |
|---|---|---|
| Parent navigation | One Financial Operations workspace; no misplaced or duplicate tabs | ☐ |
| Staff permissions | Admin-only tabs/actions are hidden and blocked | ☐ |
| Dashboard | Metrics and safeguards render correctly | ☐ |
| Synthetic run | A local run and intent appear; no Xero document appears | ☐ |
| PO/Invoice views | Proposed records reconcile to the run ledger | ☐ |
| Exceptions | Comment and resolve affect local ledger only | ☐ |
| Schedules | No task is enabled or registered | ☐ |
| Candidate discovery | Exact named lookup is audited; no broad enumeration | ☐ |
| Candidate Roster | One explicit record resolves/records needs-data safely | ☐ |
| Shadow evidence | Reviewer-held test is reviewed with a meaningful comment | ☐ |
| Historical preview | Bounded GET-only lookup returns results without import | ☐ |
| Integration checks | VTiger and Xero readiness results are recorded without secrets | ☐ |
| Configuration audit | Harmless non-secret test key appears in immutable audit | ☐ |
| Cutover Centre | Families are write-locked and no live action exists | ☐ |
| Disabled pack | Pack is local evidence only; no Xero request was sent | ☐ |

> **Do not request or execute live cutover from this guide.** The next stage requires a new, document-specific approval that names the exact source, proposed Draft document(s), party, amount, reference, existing-writer handoff and rollback choice.
