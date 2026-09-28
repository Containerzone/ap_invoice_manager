# All Financial Operations — Release Preparation Report

**Application:** ContainerZone Supplier Invoice Manager (AP Management)  
**Prepared:** 28 September 2026  
**Release manifest:** `AFO-REL-20260928165956-26A1EE83`  
**Mode:** **Preparation only — no financial writer enabled**

> **No Xero purchase order, Xero invoice, Xero bill, Xero Draft, VTiger record, Operations/VTiger/Make setting, workflow URL, or existing schedule was changed by this preparation.**

## Executive outcome

The all-family release preparation layer is complete and an auditable manifest was frozen for all required financial families. **The manifest is not eligible for go-live:** it contains **0 included, 0 held and 14 excluded families**.

This is intentional. The system will not request or permit a broad activation while mandatory gates are incomplete.

| Gate | Current verified state | Effect |
|---|---|---|
| AP Xero tenant — GET-only check | **Blocked**: stored AP token is expired | Every family excluded; no Xero preflight can be trusted until re-authentication and a new passing GET-only check |
| AP VTiger — challenge + documented form login | **Passed** | Read-only exact-source lookup is available; it does not write to VTiger |
| Exact named source / reviewer-confirmed shadow evidence | **Missing for every family** | No candidate can enter this release |
| Current due/queued Draft-document manifest | **Empty** | No concrete source-to-Draft cutover is available |
| Legacy writer inventory and disable action | **Missing for every family** | No existing Operations/VTiger/Make writer can be changed or superseded |
| AP financial production writer | **Server-disabled** | No Xero write transport can run |
| Recurring schedule activation | **Disabled** | No financial schedule task was created or enabled |

## What was implemented

### 1. Frozen all-family release manifest

A new local release ledger preserves, per release:

- AP writer implementation version and a deterministic hash of the active financial rules;
- current, **read-only** Xero and VTiger readiness results;
- proposed release owner and maintenance-window notes;
- a current-document manifest when confirmed evidence exists;
- included/held/excluded totals;
- append-only preparation and local-inventory audit entries.

Every family row preserves its reference pattern, party/account and calculation rules, first trigger, Draft-only restriction, source/Xero preflight evidence, payload conditions, disabled AP endpoint identifier, schedule intent, legacy-writer inventory and rollback statement.

### 2. All required families recorded

| Family | Expected reference / document identity | Current release state |
|---|---|---|
| Initial Container Control — Asset | `A<Container Control>` | Excluded |
| Initial Container Control — Customer Sale | `S<Container Control>` | Excluded |
| Initial Container Control — For Hire | `H<Container Control>` | Excluded |
| Recurring For Hire | `HC<Container Control>-<suffix>` | Excluded — schedule remains disabled |
| Origin Storage Activation | Storage invoice + `JD<Deal>` + `GD<Deal>` | Excluded |
| Destination Storage Activation | Storage invoice + `JD<Deal>` + `GD<Deal>` | Excluded |
| Recurring Storage | Storage invoice + `GD<Deal>`; no recurring `JD` PO | Excluded — schedule remains disabled |
| Storage Finalisation / Recovery | Existing Draft storage customer invoice only | Excluded |
| Main Customer Invoice | `INV-<Deal digits>` | Excluded |
| Deposit Invoice | `INV-<Deal digits>-D` | Excluded |
| Final Weight — Overweight | Existing Draft `INV-<Deal digits>` adjustment only | Excluded |
| Final Weight — Underweight | Existing Draft `INV-<Deal digits>` due-date adjustment only | Excluded |
| Extra Hire | `INV-<Deal digits>-<numeric suffix>` excluding `-D` | Excluded |
| Warranty Customer Invoice and Aviso PO | Customer invoice + `I<Deal>` Aviso PO | Excluded |

## Safety controls now available

### Financial Operations → Controls → All-Family Release

Administrators can now:

1. **Prepare a fresh manifest** — runs one fresh GET-only AP Xero check and one authenticated read-only VTiger check, then freezes current rule/evidence state.
2. **Review every family** in one matrix with its release status, status reason, reference pattern, scheduled/event trigger, evidence links and Draft-only guard.
3. **Record non-secret legacy writer inventory** — identifier, current owner and exact disable action. This is local documentation only; it cannot alter the existing writer.
4. **Export the matrix as CSV** for AP/IT cutover review.

The UI deliberately contains **no Activate / Enable / Send to Xero action**. It also identifies the reserved authenticated AP release endpoint, which returns a server-enforced no-write response while the writer lock is active.

## Draft-only, GST and duplicate safeguards

- The release manifest retains the existing **Draft-only** restriction. A non-Draft collision or amendment path is held locally and never replaces or modifies an existing financial document.
- Purchase-order amounts continue to be represented as **GST-exclusive** Xero lines. Customer-document GST treatment is frozen from the configured financial rules; storage customer GST remains blocked where configuration is pending.
- A family cannot become included without a current, exact-source shadow test, a read-only Xero preflight and a complete current-document manifest.
- Existing document statuses, contact identity and document numbering must be verified against the named source during the later per-family test; current status is never inferred from historical bulk data.

## Required work before any final activation request

The following work is deliberately outside this preparation release:

1. **Re-authenticate AP Management Xero**, then use Financial Operations → Automation Settings → **Test read-only connection**. The result must pass for the expected `CONTAINERZONE` tenant.
2. For each family, enter an **exact named source** into Candidate Roster; resolve it uniquely using the VTiger read-only finder.
3. Run a **shadow evidence** test against that exact source. Review the source snapshot, active rule facts, proposed Draft document(s), line amounts, GST treatment, contact, account, item codes, status and Xero preflight.
4. An AP administrator must **confirm** a clean test with a factual review comment. A blocked, held, different or incomplete test cannot be confirmed.
5. Record the precise overlapping **legacy writer/schedule identifier, owner and disable action**. Do not guess or disable it yet.
6. Refresh the all-family manifest. Only a family with all gates may become **included**.
7. Before any activation, present a **new document-specific approval request** naming the source record, proposed Draft document number(s), counterparty, amounts, legacy writer handoff, maintenance window and rollback plan.

> The current manifest does **not** satisfy Step 7. No financial activation is requested or authorised by this report.

## Validation completed

- `npx tsc --noEmit` — passed
- `pnpm test` — **44 test files, 253 tests passed**
- `pnpm build` — passed
- Release-specific tests cover all 14 family definitions, missing-gate exclusion, writer-disable endpoint behaviour, administrator-only manifest preparation and local legacy-writer inventory recording.
- A source audit found **no POST/PUT/PATCH/DELETE transport** in the new release-manifest, disabled-release-endpoint, persistence or disabled-writer modules.

Build-only warnings about CSS import ordering and JavaScript chunk size were reported by Vite; they do not affect the release writer lock or the test result.
