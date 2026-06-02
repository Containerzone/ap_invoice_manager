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
