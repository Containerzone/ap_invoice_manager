# Phase 1.6 — Candidate Evidence and Cutover-Gate Handoff

**Project:** ContainerZone Supplier Invoice Manager  
**Scope:** AP Management only  
**Mode:** Shadow / evidence-only / no financial writes  
**Implementation date:** 26 September 2026

## Executive status

Phase 1.6 is implemented and validated in the AP Management project. It adds the evidence and review controls required to run **one named, exact VTiger candidate at a time** once integration access is healthy.

> **Cutover remains blocked.** The current AP Xero token is not usable and the VTiger read session was rejected during the named-candidate check. No live Xero document, VTiger record, callback URL or schedule was changed.

## Delivered controls

| Area | Delivered capability | Safety boundary |
|---|---|---|
| Exact VTiger Candidate Finder | Admin searches one exact Deal or Container Control business number using configurable, AP-side field aliases. It returns **found**, **not found**, **ambiguous** or **blocked**. | Uses VTiger GET challenge/login/query calls only; never lists a whole module and never changes CRM data. |
| Candidate audit | Each lookup and each pre-test revalidation writes a dated discovery record with the named number, candidate ID(s), outcome and actor. | No raw CRM payload or credentials are retained in the discovery audit. |
| Rules-based expected facts | Active non-secret AP rules generate document numbers, party/account/item/GST/date/total/line-level assertions and rule explanations for a selected candidate. | A generated clean comparison is **held**, not passed. |
| Reviewer confirmation | An admin must provide a comment to confirm or reject evidence. Only evidence flagged as review-eligible can be confirmed. | A blocked, held or different result cannot be overridden to passed. Confirmation records ledger evidence only. |
| Xero AP tenant health | Admin GET-only connection check confirms the connected organisation contains the required **CONTAINERZONE** label and records a connection audit. | No token refresh or Xero write is performed by the financial migration path. |
| Financial Operations UI | Added **Candidate Finder**, candidate audit, held-evidence review controls, and AP Xero connection evidence. | The UI states that schedules remain disabled and no live action is available. |

## Data model and audit trail

Applied additive migration: **`drizzle/0026_left_electro.sql`**.

- `financial_shadow_tests` now retains `reviewStatus`, `reviewedBy`, `reviewedAt` and mandatory reviewer-comment evidence.
- `financial_candidate_discoveries` records exact named candidate searches.
- `financial_integration_audits` records read-only VTiger/Xero checks and successful future Xero reconnects without storing credentials.
- `financial_automation_rules` is frozen into the shadow run before evidence is created, preserving rule-version traceability.

The new evidence tables were verified present in the project database.

## Read-only baseline gate check

The requested **named candidate** was checked with one safe, audit-logged lookup:

| Check | Named input | Result | Interpretation |
|---|---|---|---|
| VTiger Candidate Finder | Deal `D702903` | **Blocked** | VTiger returned `Specified token is invalid or expired` during the read session. No candidate ID was accepted and no shadow test was run. |
| Xero AP tenant health | Existing AP Management connection | **Blocked** | AP Management has no usable Xero token, so no organisation/tenant validation could run. No Xero call that changes state was issued. |

Both outcomes are retained in the new candidate/integration audit ledger. Because a relevant candidate did not resolve uniquely and Xero is not connected, **no baseline workflow-family test was created**. This is the correct gate behavior; no source values were invented and no bypass was used.

## Validation completed

| Validation | Result |
|---|---|
| TypeScript | Passed (`npx tsc --noEmit`) |
| Full regression suite | **39 test files, 231 tests passed** |
| Production build | Passed (`pnpm build`) |
| Candidate finder tests | Exact lookup, ambiguity, escaped input, alias fallback and credential-blocked result covered |
| Evidence-review tests | Admin-only review, reviewer comment requirement and blocked-result confirmation guard covered |
| Xero health tests | GET-only operation and expected-tenant mismatch guard covered |
| No-write audit | No `POST`, `PUT`, `PATCH` or `DELETE` request method exists in the financial validation/candidate source paths |

The build reports existing non-blocking CSS import-order and bundle-size warnings only.

## Required next gates — do not skip

1. **Reauthenticate the AP Xero connection** in **Settings → Xero Integration** with the AP/ContainerZone Xero organisation selected. Then, in **Financial Operations → Automation Settings**, run **Test read-only connection** and verify it reports the expected `CONTAINERZONE` tenant.
2. Have the AP/IT owner restore or validate the **read-only VTiger integration credential/session**. Do not paste credentials into tickets, chat or the application UI.
3. In **Financial Operations → Candidate Finder**, run the exact business number again. Only proceed if it returns one unambiguous candidate.
4. Run **one** candidate shadow test for the applicable workflow family. Review the source/rule/expected/actual/preflight evidence and add a meaningful admin comment to confirm or reject it.
5. Repeat one named test per workflow family only after the preceding result has been reviewed. Keep all schedules disabled and all workflow execution in shadow mode.

## Explicitly not performed

- No Xero purchase order, invoice, bill, contact, item, payment, approval, void or deletion was created or modified.
- No VTiger record was created, updated or deleted.
- No existing webhook URL, CRM workflow URL, live schedule or callback was modified.
- No broad historical import was started.
- No runtime rule mapping was silently changed after the previous Phase 1.5 validation.

## Future controlled cutover preconditions

A future live cutover requires separately approved, evidence-backed sign-off for all of the following:

1. Valid AP Xero tenant connection confirmed as **CONTAINERZONE**.
2. Valid AP-owned read-only VTiger source access and named candidate results.
3. One reviewed shadow test per relevant workflow family with documented exceptions resolved or explicitly accepted.
4. Document-specific approval before any future live financial action.
5. A separate review/approval before enabling any schedule or changing any external callback/workflow configuration.
