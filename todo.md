
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
