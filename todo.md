
## AP Management Release Readiness, Recurring Selectors and Controlled Cutover (2026-09-30)

- [x] Applied `0034_fair_archangel.sql`: added AP-only per-family discovery/evidence hashes, factual `no_current_candidate` manifest status, current due/Draft manifest fields, legacy storage-event provenance, and disabled post-success mapping readiness fields. Existing shadow-created storage rows are now explicitly `unverified_legacy` and cannot drive recurrence.
- [x] Added one controlled, administrator-invoked family discovery workflow for all **14** release families. VTiger discovery accepts only configured positive current-state predicates, hard-limits results to 10, sorts by recent update, and reports `NO_CURRENT_CANDIDATE` or mapping/access blocks without a broad CRM/history scan. A reviewer must select exactly one source/period into the existing Candidate Roster.
- [x] Added immutable source/rules/Xero-preflight hash evidence to roster confirmation. A current manifest refresh re-reads the exact selected VTiger record and exact Xero document/contact/item candidates; any mismatch persists a local stale hold and excludes that family from inclusion.
- [x] Added disabled recurring selector logic: For Hire requires current FOR HIRE + ON HIRE/IDLE state, a consecutive next 30-day period, supported 20/40-foot type, supplier and current HC 20 E/HC 40 E purchase pricing; storage requires a verified AP execution-state event and produces GD customer/supplier proposals only (never recurring JD). No catch-up, historical replay or bulk selection is available.
- [x] Registered/verified local definitions for the exact disabled paths `/api/scheduled/financial-writer/recurring_for_hire` (`0 0 0 1 * *`) and `/api/scheduled/financial-writer/recurring_storage` (`0 5 13 * * *`). A recognised disabled cron request records a `disabled_no_write_audit`; no financial Heartbeat job was created.
- [x] Prefilled AP-local legacy handover inventory for every family and explicitly documented excluded Operations tasks/endpoints. This only renders local documentation; it does not inspect, call, pause or edit Operations, VTiger, Make or existing schedules.
- [x] Added disabled VTiger post-success mapping readiness for `ModComments`, `Calendar`, `Potentials.cf_potentials_hireenddate`, and an AP assigned-user ID. Validation is authenticated VTiger GET metadata only; no note, task or Hire End Date update can run while `FINANCIAL_VTIGER_POST_SUCCESS_ENABLED` remains false.
- [x] Updated the existing Candidate Roster, All-Family Release and AP Webhook Interface UI: it shows bounded candidate evidence, source/rules/preflight hashes, `NO_CURRENT_CANDIDATE`, current due/Draft evidence, prefilled handovers/exclusions, actual deployed route paths/source entity types, and deterministic event-ID guidance without exposing any secret.
- [x] Verified `npx tsc --noEmit` and `pnpm test`: 57 Vitest files / 309 tests pass before final build. The release remains readiness-only and disabled.
- [ ] Future gate: a named document-specific approval must show the exact source, legacy writer pause action, AP event/schedule change, Xero Draft payload/preflight and hashes, VTiger post-success operation, and maintenance window before any external writer, schedule, flag or Xero document can change.

## AP Readiness Collection — 30 September 2026

- [x] Ran AP-only read-only readiness collection: verified the CONTAINERZONE Xero tenant, verified core VTiger read-only login, executed controlled discovery for all 14 families, validated disabled post-success mapping metadata, and prepared manifest `AFO-REL-20260930174733-8125B304`.
- [x] Recorded factual result: 12 families are held because the bounded current-candidate mapping configuration is absent; Recurring Storage and Storage Finalisation / Recovery are `NO_CURRENT_CANDIDATE` because no verified AP execution-state storage event exists. No candidate was selected, no shadow evidence was confirmed, and no financial document was proposed for execution.
- [x] Confirmed no financial schedule record/Heartbeat exists and no Xero write, VTiger record/workflow change, Operations/Make change, or live flag activation occurred.
- [ ] Provide the approved read-only VTiger source field/stage mappings for the 12 non-storage families, resolve VTiger metadata describe access and supply the AP assigned-user webservice ID, then re-run bounded discovery before any reviewer selection or shadow confirmation.

## Single-Family Live Pilot Preparation — 30 September 2026

- [x] Simplified Financial Operations → Controls → AP Webhook Interface into one Financial Pilot Tracker: event receipt, AP proposal, named approval, verified Xero Draft read-back, held/error state and a concise first-pilot information checklist.
- [x] Preserved the server-only Xero Draft boundary. The tracker does not expose a browser write action, enable a schedule, change VTiger, or reveal the webhook secret.
- [x] TypeScript check and production build passed after the tracker update.
- [ ] Receive one exact pilot source/family, expected Draft reference/type, counterparty, total, GST, dates and line summary; present the exact Xero Draft payload/preflight for user confirmation before any external configuration or Xero Draft write.

- [x] Replaced the detailed webhook-contract view with a ten-row Trigger Dashboard matching the business triggers: Container Control acquisition, Recurring For Hire, Storage activation, Recurring storage, Storage finalisation, Main customer invoice, Deposit invoice, Final weight adjustment, Extra Hire and Warranty reconciliation. Storage activation and Final weight adjustment aggregate their two internal routes into one row each.

- [x] Configured the private `FINANCIAL_AP_WEBHOOK_SECRET` and verified an authenticated AP dry-run request: accepted event, held before any financial action, no Xero write method invoked and no schedule registered.
- [x] Changed the dashboard to show all 12 separate VTiger webhook routes individually (including Origin/Destination Storage and Overweight/Underweight Final Weight), with Draft results linked to the exact webhook workflow run.
- [ ] Superseded for the current storage-only phase: do not reconfigure all twelve VTiger actions. A single exact storage-stage pilot handover requires its own review and documented legacy-writer pause before any destination change.

## Narrow Loaded-Container Storage (2026-10-01)

- [x] Added authenticated Deal-only `POST /api/webhooks/vtiger/deal-storage` and verified VTiger `Potentials`, `Accounts`, `Contacts`, `Vendors`, and `ModComments` metadata through GET-only describe. No VTiger workflow URL was changed.
- [x] Added three-document initial-period rules, unique AP storage event/suffix ledger, guarded readback-driven write coordinator, read-only rows in the existing Trigger Dashboard, and partial-failure/write-back isolation. Applied additive migration 0035.
- [x] The owner chose existing `JD 20` / `JD 40` Xero item codes by container size. GET-only checks confirm both purchased items have native purchase descriptions/account 310 and accounts 200/310/311 are active. The broad financial writer remains locked; a separate storage-only Draft gate is prepared.
- [x] Added an administrator-only, read-only **Storage Drafts** tab under Financial Operations → Document Operations; no manual stage button, new app or schedule.
- [x] Narrow storage-only Draft transport is prepared: only a claimed AP event with persisted current hashes, exact Deal/suffix numbers, expiring approval and legacy handoff can POST a new Draft. Each receipt stays locked in-flight; generic financial writers remain globally disabled.
- [x] TypeScript, **61 test files / 341 tests**, and build pass; unauthenticated route returns 401; initial storage ledger has zero live events. GET-only preflight confirmed current Xero accounts and existing size-specific JD items.
- [x] Bounded read-only shortlist found D702885 future-dated (Date In 2026-10-05) and D702839 already having all three intended Xero references. Neither is suitable for the first new Draft without reconciliation; no source selected.
- [ ] **Not live:** No exact named Deal/three-document approval, legacy writer pause confirmation, or enabled storage deployment flag exists. No Xero Draft, VTiger record/workflow URL, Operations setting, Make scenario, or schedule was changed. Obtain a safe exact pilot source, present document payload and get document-specific confirmation before activation.
- [ ] The new attachment excludes recurring storage, finalisation and unrelated workflows; none was activated. See `docs/loaded-storage-draft-handoff.md` for mapping and pilot prerequisites.

## Exact storage pilot checks — 2026-10-01

- [x] D702834 (VTiger 5x479658) was read only: stage `1 DETAILS CONFIRMED`, Storage Required `Yes at Destination`, Date In blank. Not eligible; no Draft attempt.
- [x] D702885 (VTiger 5x484050) was read only: qualifying Destination stage but Date In 2026-10-05 is future-dated as of 2026-10-01 Sydney. Exact Xero refs `JD702885` and `GD702885` already exist as Drafts; `INV-702885-A` exists as DELETED. Existing POs have ex-GST subtotals $275.00 and $35.72 versus proposed rule amounts $250.00 and $42.21. Do not overwrite, duplicate or suffix-bypass.
- [x] Corrected exact ACCREC Xero preflight to treat DELETED and VOIDED number matches as occupied. TypeScript, 61 test files / 342 tests and production build pass. No financial writer gate or VTiger/Operations workflow was enabled or changed.
- [ ] Obtain an unbilled eligible named Deal or separately agree an exact D702885 reconciliation/partial-document plan with the legacy writer owner. Present a document-specific payload and handoff for confirmation before any Xero financial write.
- [x] Owner confirmed the new AP storage rates and storage-only customer invoice are authoritative for future events; classify D702885 as a **legacy reconciliation-only case**. Refreshed exact VTiger/Xero facts and recorded the existing DELETED invoice, two DRAFT POs, dates, parties and GST in the storage handoff. No AP storage event/suffix row was reserved and existing records remain untouched.
- [ ] Before a new Deal pilot, coordinate the **shared Origin/Destination legacy VTiger storage action** handover with Operations / IT; pausing it prematurely would interrupt financial documents, while making a test Deal now would fire the old writer. Deploy and verify the AP route/secret and agree a maintenance window before any confirmed external change. No current user instruction authorises changing existing D702885 Xero documents.

## One-off D702885 customer-invoice Draft test — 2026-10-01

- [x] Owner explicitly approved **one new ACCREC DRAFT `INV-702885-A` only** to Wez Jenkins, dated 5 Oct and due 6 Oct, Destination container `GRRU2300868` storage 5–9 Oct, $42.21 ex GST + $4.22 GST = $46.43 total. Xero documentation permits reuse of a deleted Draft's invoice number. No authorization for POs, the deleted original, VTiger, or broad webhook cutover was given.
- [x] Refreshed exact Deal, CONTAINERZONE tenant, contact, account and the DELETED invoice + two DRAFT POs; used a one-shot, **create-only** Xero operation with no retry, then exact ID and independent number read-back. New invoice ID `64a83cc1-437c-4495-8186-d33b5df439de` is DRAFT with the approved line, dates and totals. Original DELETED invoice ID `50162b52-5761-42da-8f3f-68aeba4d7475` and `JD702885` / `GD702885` are unchanged. AP financial execution ledger #1 is succeeded.
- [x] The dedicated Storage Drafts tab now distinguishes an approved invoice-only test from a stage webhook's three-document event using existing writer execution records. The one-shot script will be removed; no permanent bypass or global live flag is added.
- [ ] Automatic stage-triggered storage Draft creation remains **not live**; shared legacy Origin/Destination workflow handover still needs an agreed, separately confirmed maintenance window and valid AP route/header/payload.

## Dedicated VTiger → Xero Storage workspace — 2026-10-01

- [x] Moved initial loaded-container storage out of Financial Operations into a standalone **admin-only sidebar page** with non-secret AP receiver/gate status, Origin/Destination three-Draft event receipts, distinct invoice-only tests and an explicit shared Operations handover checklist. Existing financial and supplier-bill navigation remains unchanged.
- [x] Superseded by 11 October implementation: a storage-only standing release policy is implemented. The separate workspace still does not activate deployment gates or alter Operations/VTiger; publication and confirmed cutover remain separate.

## Live preparation after D702885 invoice-only test — 2026-10-01

- [x] Added an administrator-invoked, bounded **GET-only three-document Deal preview** to the standalone storage page. It retrieves one exact Deal/parties, checks current Sydney stage/date, AP suffix without reserving it, Xero accounts/items/contacts and exact invoice/PO numbers, and shows amounts, GST, descriptions and source/document/preflight hashes. It never creates an approval or calls a writer.
- [x] D702885 live preview correctly returns held: future Date In, ambiguous `INV-702885-A` (new Draft plus deleted history), existing `JD702885` and `GD702885` Drafts. It is not an eligible three-document pilot. All 61 test files / 348 tests, TypeScript and build pass.
- [x] Superseded implementation gap: standing storage-only policy now covers initial, recurring and finalisation/recovery without per-Deal manual approval once explicitly released. Historical reference tests do not create duplicates. External cutover, preserved Accounts-task mapping and live source delivery remain to be verified.
- [ ] Do not enable the isolated storage flag, broad flags, VTiger note-write flag, AP schedules or change Operations/VTiger/Make until an exact next-stage approval is reviewed.

## Complete loaded-storage lifecycle — 11 October 2026

- [x] Added monthly two-Draft billing (customer + GD, never recurring JD) using complete AP activation/period receipts, current source facts and the next consecutive Sydney billing period. No history inference or catch-up batches.
- [x] Added authenticated explicit-location finalisation route, exact stored DRAFT-only invoice/GD amendments, Date Out/delivery pro-rata, finalised recurrence stop, per-location lock and independent finalisation receipts. Added separately gated recovery of missing exact initial/final-period documents and the next genuinely unbilled final month; missing multiple-month history stays held.
- [x] Implemented storage-only standing release, current rules hash, effective time/approver and handover gates, plus exact persisted payload authorisation. Broad financial writing stays disabled. Server-only approval and task-UID schedule binding helpers are prepared but not invoked.
- [x] Preserved Finalise Storage Invoice Accounts task at stages 4/5/6; notes/tasks queue only after verified Drafts, and independently gated bounded daily retry filters storage workflows only. Xero success is never repeated for a note/task failure.
- [x] Expanded standalone VTiger → Xero Storage UI for initial/monthly/finalisation receipts, next due/final dates, release status and reference-only final-period checks.
- [x] Reviewed and applied additive migration 0036; existing Deal/period and Deal/suffix uniqueness retained.
- [x] Current D702885 GET-only facts: stage 16 REVIEW REQUEST, Storage Required NO, Date In 5 October, delivery 6 October, Date Out blank. Current preview holds correctly; historical fixture reference remains available. No new financial documents or history import attempted.
- [x] Final validation: TypeScript, **67 files / 411 tests**, production build and diff checks pass. Unauthenticated local finalisation returns 401. AP storage lifecycle events remain 0; only prior one-off writer execution exists. Read-only Heartbeat inspection found the same 3 mailbox/monitoring jobs and no financial task; all storage/broad live-write flags remain off. See `docs/loaded-storage-draft-handoff.md`.
- [ ] **External release pending:** publish AP checkpoint; pause/drain only matching Operations storage activation/finalisation actions and monthly task 4rB9Yofib8MRLRbijj4z9k; preserve task mapping; redirect VTiger to AP contracts; approve/enable only storage standing policy/deployment gate and register/bind AP monthly Heartbeat after publication. None performed by this implementation.
