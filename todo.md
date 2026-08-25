# AP Invoice Manager — TODO

## Phase 1: Database Schema & Migrations
- [x] Design and create `suppliers` table
- [x] Design and create `invoices` table (with status enum, extracted fields, xero fields)
- [x] Design and create `invoice_line_items` table
- [x] Design and create `email_logs` table
- [x] Design and create `conversation_notes` table
- [x] Design and create `xero_tokens` table (OAuth token storage)
- [x] Run migrations via webdev_execute_sql

## Phase 2: PDF Upload & LLM Extraction
- [x] PDF upload endpoint with S3 storage
- [x] LLM extraction pipeline: invoice ID, PO numbers, container numbers, amounts, supplier details
- [x] Supplier auto-matching logic (by name, ABN, email)
- [x] Manual supplier creation when no match found
- [x] Extracted data review/edit UI before confirmation

## Phase 3: Xero Integration
- [x] Xero OAuth2 connect/disconnect flow
- [x] Store and refresh Xero tokens securely
- [x] Fetch existing bills from Xero by invoice number / supplier
- [x] Compare extracted amounts vs Xero amounts
- [x] Flag discrepancies and update invoice status to "Flagged"
- [x] Discrepancy dashboard with side-by-side comparison

## Phase 4: Query Workflow & Email
- [x] Email dispatch from admin@containerzone.com.au via SMTP/API
- [x] Templated dispute email content per invoice
- [x] Email log stored per invoice record
- [x] Conversation notes thread per invoice (manual notes + email history)
- [x] Invoice status transitions: Uploaded → Verified → Flagged → Queried

## Phase 5: Resolution & Xero Draft Bill
- [x] Mark invoice as Resolved
- [x] Push draft bill to Xero (not auto-approved)
- [x] Link resolution to conversation thread
- [x] Invoice status: Resolved

## Phase 6: Frontend Pages
- [x] Global design system: color palette, typography, spacing tokens
- [x] DashboardLayout with sidebar navigation
- [x] Admin dashboard: total invoices, flagged count, open queries, resolved this month
- [x] Invoice list page with status filters and search
- [x] Invoice detail page: extracted data, Xero comparison, status timeline
- [x] PDF viewer panel on invoice detail
- [x] Query/email compose panel on invoice detail
- [x] Conversation notes thread on invoice detail
- [x] Supplier management page (Admin only)
- [x] User management page (Admin only)
- [x] Xero connection settings page (Admin only)
- [x] Role-based navigation (Admin vs Staff)

## Phase 7: Polish, Tests & Delivery
- [x] Vitest unit tests for extraction, matching, and status transitions (20 tests passing)
- [x] Loading states, empty states, error handling across all pages
- [x] Responsive design and accessibility review
- [x] Final checkpoint and delivery

## Bug Fixes & New Features (Post-Launch)
- [x] Fix PDF extraction — LLM not receiving/reading PDF content correctly
- [x] Add delete invoice feature (Admin only) with confirmation dialog
- [x] Auto-create full supplier profile from extracted invoice data when no match found
- [x] Improve PO number extraction with regex pattern (AD/BD/DD/ED/single-letter + 7 digits) across reference and description fields
- [x] Add invoice line items table and PDF preview panel side-by-side on invoice detail page
- [x] Editable invoice fields on invoice detail page (all extracted data fields)
- [x] Persistent "Send Query Again" button with last email body pre-filled
- [x] Invoice navigation — prev/next buttons and collapsible sidebar invoice list
- [x] Add supplier email and currency to editable fields on invoice detail
- [x] Make line items editable (description, quantity, unit price, amount) with backend support
- [x] Add "New Line Item" button in edit mode to manually add missing invoice lines
- [x] Add numbered query points section on invoice detail — staff can type/add multiple query points that are reflected in the dispute email
- [x] Add delete line item button (trash icon) on each editable row in edit mode
- [x] Multi-invoice supplier query — select multiple invoices from same supplier and send one consolidated email
- [x] Progressive query status — 1st Query Sent → 2nd Query Sent → 3rd Query Sent as follow-ups progress
- [x] Log email reply — button on each email log entry to paste/type supplier's reply and attach it to the invoice thread
- [x] Supplier name field in invoice edit mode becomes a combobox — search existing suppliers, prompt to create new if no match
- [x] Delete supplier button on Suppliers page (Admin only) with confirmation dialog
- [x] Quick-add dispute templates in Query Points panel — dropdown with common pre-written reasons
- [x] Rework Verify with Xero to look up Purchase Orders by PO number instead of matching bills by invoice number — compare PO amount vs invoice total to flag discrepancies
- [x] Multi-PO verification — verify all PO numbers found on the invoice against Xero, flag if any PO is missing or mismatched
- [x] PO line item comparison — fetch Xero PO line items and display them alongside invoice line items in the Amount Comparison section
- [x] Xero PO status display — show PO status (DRAFT/AUTHORISED/BILLED) badge in the Amount Comparison card
- [ ] Inbound email invoice submission — Mailgun webhook receives forwarded emails with PDF attachments and auto-processes them through the extraction pipeline
- [ ] Show dedicated forwarding email address on Settings page
- [ ] Email submission log — list of invoices submitted via email with sender, subject, timestamp
- [x] Green banner when billed amount is less than PO amount — show "Billed amount is under PO, safe to approve" message
- [x] Flag discrepancy when billed amount exceeds PO amount
- [x] Admin Approve button for invoices without PO numbers that cannot be verified via Xero
- [x] Push to Xero creates draft bill linked to PO numbers (or standalone bill if no PO)
- [x] Mark linked Purchase Orders as Billed in Xero after pushing draft bill
- [x] Flag invoice when Xero PO status is BILLED — do not compare amounts, show "PO already billed" error
- [x] Only compare amounts when PO status is DRAFT, AWAITING_APPROVAL, or AUTHORISED
- [x] Push to Xero (verified/under_budget invoice) — create bill in AWAITING PAYMENT stage
- [x] Push to Xero (admin-approved invoice) — create bill in AWAITING APPROVAL stage
- [x] Auto-detect paid invoices — if invoice has paid date, zero balance, or paid status then mark as PAID in Xero; otherwise use AWAITING APPROVAL
- [x] Fix: invoices not being pushed to Xero when resolve + push to Xero is clicked
- [x] Fix: wrong error message shown when PO is already billed (shows "Invoice Exceeds PO" instead of "PO Already Billed")
- [x] Add "Pushed to Xero" badge next to "Resolved" status on invoice detail
- [x] Fix: toast message after resolve+push should mention Xero push result
- [x] BILLED PO message: include paid status and payment date if PO is already paid in Xero
- [x] Threaded query emails: include full sent+received email history in each subsequent query email
- [x] Multi-PO fields: dynamic add/remove up to 15 PO number fields in invoice edit form
- [x] Per-PO match results: individual match/mismatch result for each PO number on the invoice
- [x] Approval updates PO in Xero: on approval, update PO supplier name, amount, invoice number (reference), description and line items to match invoice
- [x] Two-layer approval: staff approval for small differences (up to $30 on ≤$500, $50 on $501-$1000, $100 on $1001-$2000), admin approval required outside those thresholds
- [x] Resolve converts PO to bill: instead of creating a new bill, convert the matched PO(s) into a bill in Xero and mark as BILLED; for multiple POs create one combined bill
- [x] Date pickers: DD-MM-YY format with calendar popup; due date calendar includes quick-select buttons (7, 14, 21, 30, 60 days from issue date, End of Month)
- [x] Multi-PO: group invoice line items by PO number (1-2 letters + 6 digits in description), compare each PO's grouped line-item total against Xero PO total
- [x] PO regex: accept 1 OR 2 letter prefix + 6 digits (was 2-letter only)
- [x] Admin Approve button moved before Resolve & Push to Xero in action bar
- [x] Per-PO result card shows "Invoice lines: $X" alongside "PO total: $Y" for multi-PO invoices
- [x] Over-billed banner updated to show per-PO line-item total for multi-PO invoices
- [x] Fix: extractedPoNumbers not being saved during extraction — now scans DB line items after saving and writes all found PO numbers to extractedPoNumbers field
- [x] Fix: verifyWithXero now scans DB line items first for PO numbers (definitive source), then merges with extractedPoNumbers and raw data
- [x] Fix: groupedTotal now always uses line-item total when available (not just for multi-PO), falls back to invoice total only when no line items contain the PO number
- [x] PO pattern documented: P (Pacific National), SL (Straitlink), AZ (Aurizon), TR (Tasmanian Railways) + any other 1-2 letter prefix
- [x] Multi-PO verification summary: show total net difference (sum of all PO diffs), flag as discrepancy if ANY single PO is over-billed even if overall total is under
- [x] Reports portal: approved invoices PO variance dashboard — show each approved invoice with PO amount, invoice amount, and net over/under per PO and overall
- [x] Fix approval: update PO in Xero with supplier name, invoice amount, invoice number (→ reference), description, line items; move PO to AUTHORISED stage (skip if already BILLED)
- [x] Fix resolve: instead of creating bill from scratch, find the approved PO(s) in Xero and use Xero's create-bill-from-PO API; mark each PO as BILLED after bill is created
- [x] Duplicate invoice detection: on upload, flag if same supplier + invoice number already exists; on approval, block if PO is already matched/approved to another invoice (show which invoice it belongs to)
- [x] Keep Approve/Admin Approve buttons visible on already-approved invoices so re-approval can re-sync the PO in Xero before pushing
- [x] Multi-PO approval fix: assign only the line items that reference each specific PO to that PO's update in Xero — not all invoice line items to every PO

## Improvements & Fixes (Session 3)
- [x] Workflow enforcement: Verify → Approve/Admin Approve → Push to Xero order must be enforced; cannot skip steps; Send Query allowed at any time before Push
- [x] Xero duplicate bill check on upload: search Xero Bills by invoice number + fuzzy supplier name (handle name variations like "Pacific National Services Pty Ltd" vs "PN Services Pty Ltd"); flag with bill amount and stage (DRAFT/AUTHORISED/PAID etc)
- [x] Local duplicate rule: same invoice number + same supplier cannot be uploaded more than once at the same time (existing local duplicate detection)
- [x] PO already billed: if PO has been billed before, flag for manual rectification with "PO has already been billed" message (existing, verify still works)
- [x] Fix staff approval thresholds: $1001–$1500 → up to $100 negative variance; $1501–$2000 → up to $150 negative variance
- [x] Staff role sees only "Approve" button (not "Admin Approve"); admin role sees "Admin Approve" button
- [x] Increase max queries per invoice from 3 to 5
- [x] Invoice list columns: Invoice #, PO Number, Supplier Name, Issue Date, Due Date, Received Date, Status (in that order)
- [x] Reports: store original PO amount on first verification (new DB column); use original PO amount vs final billed amount for variance calculation
- [x] User management portal: admin can create up to 3 extra users (staff or admin role) from the app UI

## Bug Fixes & Features (Session 4)
- [x] Fix resolve workflow guard: both "approved" (staff) and "admin_approved" status must be accepted before push to Xero — investigate exact status values written by adminApprove vs staffApprove
- [x] Fix invite email: send email notification to invited user's email address when admin creates an invite
- [x] Upload PDF copy of invoice to Xero bill file attachments after successful push to Xero

## Bug Fixes (Session 5)
- [x] Fix Xero bill push: line items missing AccountCode and TaxType — Xero rejects with "Account code or ID must be specified" and "TaxType field is mandatory"
- [x] Fix Xero bill push: "Invoice not of valid status for modification" — bill already exists in SUBMITTED/AUTHORISED state; must update existing bill instead of re-creating

## Bug Fixes (Session 6)
- [x] Fix "Invoice not of valid status for modification" on A1 Tilt Trays: added robust findExistingXeroBill helper that tries GET with and without Type=ACCPAY filter; both convertPOsToBill and createXeroDraftBill pre-flight and HasErrors fallback now use this helper
- [x] Fix PDF not uploading to Xero bill: added Accept: application/json header, maxRedirects: 5, and Content-Length as string to uploadXeroBillAttachment
- [x] Fix PO match amounts not showing after Admin/Staff Approve: added refreshXeroPoResults helper that re-runs PO lookup and saves fresh xeroPoResults to DB; wired into both adminApprove and staffApprove procedures so UI shows updated match amounts immediately after approval without requiring manual re-verify

## Bug Fixes (Session 7)
- [x] Bug 1: Duplicate not flagged on upload — surface xeroBillDuplicateWarning and duplicateWarning in InvoiceUpload.tsx with 10s warning toast before navigation
- [x] Bug 2: VicFreight PO update leaving AccountCode/TaxType blank — default to account 310 (Transport Vendors) and INPUT (GST on Expenses) for new appended line items in updateXeroPODetails
- [x] Bug 3: PO match amounts not showing after Admin/Staff Approve — return fresh xeroPoResults in mutation response and apply to tRPC cache immediately (no re-verify needed)
- [x] Bug 4: PDF not uploading to Xero bill — fixed storage key mismatch (storagePut appends hash suffix; was storing pre-hash key in DB); now stores actual key from storagePut; added fileUrl-based fallback for existing invoices

## Bug Fixes (Session 8)
- [x] Fix GST flip on Admin Approve: refreshXeroPoResults was summing raw excl-GST amounts instead of applying GST (×1.1) — now uses identical GST-inclusive calculation as verifyWithXero (default 10% when taxRate is null)
- [x] Fix refreshXeroPoResults also now checks custRef field for PO matching (same as verifyWithXero)
- [x] Fix PDF attachment upload to Xero: maxRedirects was 0 on the PUT call, blocking Xero's internal redirect — changed to 5
- [x] Clarify LLM extraction prompt: amount field is always excl. GST (net line total before tax)

## Feature: Vtiger → Xero PO Creation (Session 9)
- [x] Store Vtiger API credentials as secrets (VTIGER_USERNAME, VTIGER_ACCESS_KEY, VTIGER_URL)
- [x] Webhook payload discovery: built /api/vtiger-webhook endpoint, received test payload, confirmed all field names
- [x] DB schema: po_requests table (dealId, dealNumber, status, rawPayload, poResults JSON, errorMessage, timestamps)
- [x] Webhook endpoint POST /api/vtiger-webhook: receives Deal Stage 1 trigger, stores payload, processes async
- [x] vtigerPoService.ts: full field mapping for 12 carrier cost fields, PO number construction, supplier/account mapping
- [x] GST-exclusive amounts, EXCLUSIVE tax mode, INPUT tax type, skip zero fields, duplicate PO check
- [x] PO Requests page in app: list all webhook events, per-PO status (created/skipped/error/duplicate), detail dialog
- [x] Retry mutation for failed/partial requests
- [x] Add PO Requests nav item to DashboardLayout sidebar
- [x] Auto-refresh every 10s to catch async processing results

## Bug Fixes (Session 10)
- [x] Fix #1: Use line-item poNumber as source of truth for PO list — replace extractedPoNumbers with unique set from line items in verifyWithXero, refreshXeroPoResults, and adminApprove/staffApprove
- [x] Fix #2: Never fall back to full invoice total for multi-PO invoices — if no line item matches a PO, show null/unknown instead of extractedTotal
- [x] Fix #3: Throttle parallel Xero PO lookups to max 3 concurrent with 200ms delay between batches

## Bug Fixes (Session 11)
- [x] Add poNumberEdited flag to invoice_line_items: when a user manually edits a line item's PO number, always use the edited value and ignore custRef/description scan for that line

## Bug Fixes (Session 12)
- [x] Fix Amount Comparison Xero totals: sum all found PO totals instead of using only the first found PO for xeroTotal/xeroSubtotal/xeroTax

## Bug Fixes (Session 13)
- [x] Diagnose 400 error in Xero PO creation — deep search full creation flow
- [x] Strip trailing "D" from 3-letter-prefix PO numbers (e.g. AZD702766 → AZ702766) before sending to Xero

## Bug Fixes (Session 14)
- [x] Fix duplicate PO Ref column in invoice line item edit form
- [x] Fix qty/unit price field swap on save (qty becomes blank, unit price gets qty value)
- [x] Fix Xero PO line receiving GST-inclusive amount instead of GST-exclusive unit price ($3,600 instead of $3,000)

## Bug Fixes (Session 15)
- [ ] Xero PO line still shows $3,600 (incl. GST) after Session 14 fix — diagnose and correct the unit amount sent to Xero for invoice HC1807

## UX Improvements (Session 16)
- [x] Clickable sortable column headers on Invoices page (asc/desc toggle with indicator)
- [x] Multi-select status filter (allow selecting more than one status at a time)
- [x] Resolved invoices automatically sorted to the bottom of the list

## Features (Session 17)
- [x] Attach original invoice PDF to Xero bill's related files when invoice is approved and pushed to Xero

## Features (Session 18)
- [x] Fix PDF attachment 401 error: added accounting.attachments scope detection + Settings page warning when token lacks the scope
- [x] Invoices list: add GST-inclusive total amount column
- [x] Invoices list: add notes icons — QN for query notes, IN for internal notes
- [x] Admin can resolve/push no-PO invoices under $500 to Xero without PO matching
- [x] Archive paid invoices: hide from main list, auto-delete 90 days after payment date

## Line Item Calculation Fix (Session 18)
- [x] Auto-calculate Amount = Qty × Unit Price in line items editor
- [x] Add "Ex GST" label next to Unit Price and Amount column headers

## GST Fix (Session 18)
- [x] Fix Vtiger PO creation: already correct (uses TaxType INPUT and LineAmountTypes Exclusive)
- [x] Fix PO line items display: show assumed 10% GST when taxAmount is 0

## Duplicate Invoice Number Fix (Session 18)
- [x] Fix Xero duplicate check: only skip creation if BOTH invoice number AND supplier name match (currently skips on invoice number alone, causing wrong supplier's bill to be returned)
- [x] Show warning alert before Xero push if another supplier's bill with the same invoice number already exists in Xero

## ACCREC vs ACCPAY Fix (Session 18)
- [x] Fix findExistingXeroBill to only match ACCPAY bills (ignore ACCREC customer invoices with same number)
- [x] Fix checkXeroBillDuplicate to only flag ACCPAY bills (not customer invoices)

## Force Create New Bill on Conflict Acknowledgement (Session 18)
- [x] Pass forceCreateNew flag from frontend when user acknowledges invoice number conflict, skip findExistingXeroBill in resolve flow

## User Termination Feature (Session 19)
- [x] Add `status` column (active/disabled) to users table via DB migration
- [x] Add `users.disable` and `users.enable` adminProcedures in routers.ts; enforce disabled check on every protectedProcedure
- [x] Users page: show Disable/Enable button per user with confirmation dialog; show Disabled badge on disabled users

## Accounts Receivable SOP (Session 19)
- [x] Document purchase order prefixes, numerical formats, lifecycle stages, and container hire/purchase procedures
- [x] Deliver standalone SOP attachment with worked examples for every PO-number pattern; no application functionality changes
- [x] Deliver standalone SOP titled "Transport Purchase Order Numbers" covering only Stage 1 automated operational transport POs, with detailed examples

## Safe Xero Supplier Contact Matching (Session 19)
- [x] Add name-first and email-validation Xero contact matching, including distinct no-match, name/email conflict and multiple-candidate outcomes
- [x] Block automatic contact creation for name/email conflicts or multiple candidates; add an authorised contact-selection/approval path
- [x] Update Xero bill/PO creation flows to use the approved contact resolution and add Vitest coverage

## Cleared PO Persistence Fix (Session 19)
- [x] Preserve an intentional blank PO list when invoice fields are saved; do not reconstruct it from line items or OCR/extraction data
- [x] Ensure a cleared no-PO invoice below $500 exposes the admin approval path and add regression coverage

## SMTP Credential Verification (Session 19)
- [x] Verify the current SMTP password using a non-delivery authentication check and report the result
- [x] Re-verify the updated SMTP password using a non-delivery authentication check and report the result

## Xero Supplier Name Tie-Breaking (Session 19)
- [x] When multiple candidates share a first-name match, use the sole exact email match to resolve the supplier automatically; retain manual selection only when email does not break the tie

## Xero PO Lookup Investigation (Session 19)
- [x] Review recent PO-not-found errors, identify the lookup failure mode, and provide a corrective recommendation
- [x] Investigate why Dry Creek Storage Pty Ltd was not matched despite an existing Xero supplier contact
- [x] Ensure non-404 Xero PO lookup failures are surfaced as API errors rather than persisted as PO-not-found results

## Xero Bill Creation Rate Limit Handling (Session 19)
- [x] Add bounded HTTP 429 retry handling to Xero bill creation and return a clear retryable failure if Xero remains throttled

## Xero 429 Root-Cause and Permanent Fix (Session 19)
- [x] Map all Xero requests triggered by verify, approve, supplier resolution, push and attachment flows
- [x] Confirm current Xero limits and capture live rate-limit response headers
- [x] Implement central per-tenant request throttling, in-flight deduplication and short-lived read caching
- [x] Eliminate redundant Xero calls across invoice workflows and add regression/load coverage

## Xero Daily Allowance Guidance (Session 19)
- [x] Confirm the current Xero process for requesting a higher daily API allowance and advise the account owner

## Xero 5,000-Call Capacity Estimate (Session 19)
- [x] Estimate practical daily invoice push capacity by current Xero workflow and caching assumptions

## Xero Tier Verification (Session 19)
- [x] Verify whether yesterday's exhausted Xero allowance was the 1,000-call Starter tier or the 5,000-call higher tier, and document the evidence

## Xero Contact Name Matching Fix (Session 19)
- [x] Ignore one-letter leading name tokens when matching Xero supplier contacts; require a meaningful name match before showing candidates
- [x] Ensure no valid name-or-email match proceeds to create a new Xero contact and immediately refreshes the relevant lookup cache
- [x] Add regression coverage for newly created suppliers such as "A & F Transport"
- [x] Make the Resolve & Push dialog clearly identify every outstanding required confirmation when an invoice-number conflict and supplier-contact selection both apply
- [x] Verify Resolve & Push unlocks after the invoice-number conflict acknowledgement when the supplier contact is already confirmed
