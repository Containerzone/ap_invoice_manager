# Phase 1.7 — Read-Only Connectivity and First Shadow Evidence Report

**Project:** ContainerZone Supplier Invoice Manager / AP Management only  
**Mode:** **SHADOW / NO WRITE**  
**Implementation date:** 27 September 2026

## Scope and safety result

Phase 1.7 was implemented only in the AP Management project. It adds a controlled **Candidate Roster**, stronger connection-readiness evidence, and a roster-only shadow-test gate.

> **No live cutover is authorised or implemented.** No Xero document, contact, item, payment, configuration or financial record was created or altered. No VTiger record, workflow URL, Make scenario, callback URL or schedule was altered. Operations / Supplier Sourcing CRM was not accessed or used.

## Read-only connection readiness

| Integration | Result | Evidence and interpretation |
|---|---|---|
| AP Management Xero | **Passed — GET-only validated** | The AP-owned OAuth connection was verified against the expected **CONTAINERZONE** tenant. The health route issued only GET requests and did not refresh a token or call a financial mutation helper. |
| AP Management Xero token | **Expiring soon** | At the Phase 1.7 check, the current token had a short remaining lifetime. The application shows non-secret expiry/health state and does not refresh the token automatically in the financial migration path. |
| AP Management VTiger | **Blocked** | The challenge endpoint is reachable, but the required GET-only login returns `Specified token is invalid or expired`. A challenge by itself is no longer treated as a successful connection. |

Each connection check is retained as a non-secret, append-only integration audit event. The Financial Operations readiness cards show the expected tenant, non-secret token health/expiry, latest check and last successful check.

## Candidate Roster controls

The new **Candidate Roster** section permits an AP administrator to add only a small, explicit list of named candidates. Each row records:

- Deal or Container Control business reference;
- intended workflow family and branch;
- optional business note;
- owner and reviewer;
- precise discovery state (`draft`, `found`, `not found`, `ambiguous`, `blocked` or `needs data`); and
- links to the latest exact discovery and shadow-evidence records.

A roster row is resolved only by a VTiger **GET challenge/login/exact-query** sequence. The system does not enumerate a VTiger module or bulk-search CRM records. Shadow evidence can be created only from a roster row that has resolved to exactly one record, and only after fresh AP-owned Xero and VTiger GET-only readiness checks both pass.

## First Initial For Hire Container Control evidence

No valid named current For Hire Container Control was supplied, and the VTiger AP read-only login is not currently valid. The system correctly did **not** guess a candidate or search broadly.

| Evidence | Result |
|---|---|
| Shadow test | **#30001** |
| Workflow / branch | `container_control_acquisition` / **Initial Container Control — For Hire** |
| Status | **Needs data** (review pending) |
| Exact blocker | A named current For Hire Container Control with a valid Control number, 20/40-foot type, supplier/contact and Collection Date has not been supplied; VTiger login is invalid or expired, so exact discovery cannot identify one safely. |
| External side effects | **None** — this was an AP ledger evidence record only. |

Because no exact candidate resolved, there is no supplier/contact, `HC 20`/`HC 40` item, `H<Container Control>` duplicate preflight, proposed date/amount, or reviewer decision to report yet. Those facts will be captured only when the named source is available and both integrations pass.

## No-write proof

| Control | Result |
|---|---|
| Xero access in the financial migration path | GET-only connection, tenant, document, contact and item preflight reads. |
| Token handling | No automatic token refresh in the financial migration path. |
| Xero writes | No `POST`, `PUT`, `PATCH` or `DELETE` path exists in the Phase 1.7 candidate/readiness source. |
| VTiger access | GET-only challenge, login, exact query and retrieve operations. |
| Schedules | No financial schedule was registered or enabled. |
| Runtime record | Shadow test #30001 explicitly returned `xeroWritePermitted: false`; its status is `needs_data`. |

## Validation

| Validation | Result |
|---|---|
| TypeScript | Passed (`npx tsc --noEmit`) |
| Full regression suite | **40 test files / 238 tests passed** |
| Production build | Passed (`pnpm build`) |
| New coverage | Candidate Roster admin-only entry, exact roster resolution, roster-only shadow execution, dual integration-readiness blocking, Xero expiry reporting and full GET-only VTiger login verification |

The build continues to report only the existing non-blocking CSS import-order and bundle-size warnings.

## Required remediation and next named shadow test

1. AP/IT must renew the existing **AP Management read-only VTiger access key/session** through the secure server-side secret mechanism. Do not copy Operations credentials, alter a VTiger workflow/URL, or place credentials in chat or the UI.
2. If Financial Operations shows the AP Xero token as expired, an authorised AP user must reauthenticate via **Settings → Xero Integration** and confirm the expected **CONTAINERZONE** tenant through the GET-only connection test.
3. Add **one named current For Hire Container Control** to Candidate Roster. It must have a valid Control number, 20/40-foot type, supplier/contact, Collection Date, and either a monthly hire cost or a legitimate blank cost for the $120/$240 ex-GST fallback.
4. Resolve only that roster row. If it resolves uniquely and both connection checks pass, run the **Initial Container Control — For Hire** shadow test.
5. An AP administrator must review the full source/rules/proposal/Xero-preflight evidence and record a meaningful confirm or reject comment.

The next action is **one named read-only For Hire shadow test only**. It is not a live cutover candidate, and no live financial action is recommended.
