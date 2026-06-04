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
