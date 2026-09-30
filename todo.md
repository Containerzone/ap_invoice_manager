
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
