# Shadow Validation Handoff Report

**Project:** ContainerZone Supplier Invoice Manager (AP Management only)  
**Phase:** 1.5 — Shadow Validation and Cutover Readiness  
**Prepared:** 26 September 2026 (UTC)  
**Decision:** **Do not start cutover.**

> This report documents AP Management's no-write shadow-validation readiness. It does not authorise any Xero, VTiger, Operations, schedule, or webhook change.

## 1. Scope and separation confirmation

The work was confined to the AP Management project.

| Control | Result |
|---|---|
| Operations / Supplier Sourcing CRM changed | **No** |
| VTiger workflow URLs, conditions, Make scenarios, or schedules changed | **No** |
| Xero document, contact, item, payment, or token write attempted | **No** |
| Financial schedule created or enabled | **No** |
| Existing AP invoice, bill, PDF, email, supplier, workflow-monitoring, and transport-PO functions modified for cutover | **No** |
| New database work | Additive evidence/audit migration only (`0025_furry_sauron.sql`) |

## 2. Financial Automation Settings status

The **Financial Operations** workbench now has an admin-only **Financial Automation Settings** tab displaying:

- Enforced global state: **`SHADOW / NO WRITE`**.
- AP Management's own VTiger readiness and GET-only connection test.
- AP Management's Xero tenant label / token state and a GET-only connection test.
- Shadow webhook path and authentication-configuration presence, without exposing the secret.
- Disabled recurring For Hire and storage schedule intent; no schedule is registered or enabled by this implementation.
- Central non-secret rule configuration for accounts, item codes, default rates, GST, warranty supplier/account, recurring eligibility, and draft-status rules.
- Append-only configuration audit entries when an administrator saves a non-secret configuration change.

### Read-only integration checks

| Integration | Result | Evidence |
|---|---|---|
| VTiger | **Passed** | AP Management's GET-only challenge succeeded. It did not change a CRM record, URL, or schedule. |
| Xero | **Blocked safely** | AP Management's stored Xero token was expired. The test did **not** refresh it or call Xero. The configured AP tenant label is `CONTAINERZONE`; the token should be re-authenticated through the existing Settings flow before any Xero preflight. |
| Shadow webhook | Status visible in UI | Endpoint is `/api/financial-workflows/shadow-events`; it accepts only `shadow` / `dry_run` modes and requires the server-held shadow secret. |

No credential, OAuth token, access key, webhook secret, tenant token, or Operations configuration is included in this report or the UI.

## 3. Shadow Test Register and evidence pack

A durable **Shadow Test Register** has been added under Financial Operations. Each entry stores:

- workflow family and branch;
- named source identifier;
- UTC evidence timestamp, displayed in Australia/Sydney in the UI;
- source refresh timestamp;
- expected business-rule facts;
- actual source values and AP evaluator proposal;
- line descriptions, quantities, rates, account codes, GST treatment, dates, ex-/inc-GST totals;
- field-level comparisons and a difference explanation;
- GET-only Xero duplicate/contact/item/document preflight evidence;
- related workflow-run, intent, and exception IDs; and
- `passed`, `failed`, `held`, `blocked`, or `needs_data` status.

The register provides a **CSV export** and contains no live-create, live-retry, or schedule-enable action. A deliberate **Record needs-data** control lets an administrator record a missing-condition evidence row without inventing source data.

### Current evidence status

**14 `needs_data` entries** were recorded against the AP-held named Deal reference **D702903**. This is a real reference retained in AP Management's existing PO-request ledger; it was used only to name the blocked test evidence. It was not reprocessed and no source data was modified.

| Test family / branch | Status | Exact blocker |
|---|---|---|
| Initial Container Control — Asset | Needs data | No VTiger Webservice `moduleId x recordId` and no business-approved expected result for a named Container Control; Xero token also expired. |
| Initial Container Control — Customer Sale | Needs data | Same blocker. |
| Initial Container Control — For Hire | Needs data | Same blocker. |
| Recurring For Hire — ON HIRE / IDLE eligibility | Needs data | Same blocker. |
| Storage activation — Origin | Needs data | Same blocker. |
| Storage activation — Destination | Needs data | Same blocker. |
| Recurring storage | Needs data | Same blocker. |
| Storage finalisation / guarded recovery | Needs data | Same blocker. |
| Main customer invoice | Needs data | Same blocker. |
| Deposit invoice | Needs data | Same blocker. |
| Final weight — Overweight | Needs data | Same blocker. |
| Final weight — Underweight | Needs data | Same blocker. |
| Extra hire | Needs data | Same blocker. |
| Warranty and Aviso PO | Needs data | Same blocker. |

> No result is claimed as a pass. This is intentional: the phase requirement forbids inventing source data or changing VTiger to make a test pass.

## 4. No-write proof

The financial validation paths were examined and tested as follows:

1. The evaluator remains locked to `mode: "shadow"` and returns `xeroWritePermitted: false`.
2. The new financial Xero service uses **only `axios.get`** through a GET-only helper. It has no `POST`, `PUT`, `PATCH`, `DELETE`, token-refresh, or Xero request-manager write call.
3. The live read-only Xero check stopped before any API call because the token was expired; it did not refresh or retry the token.
4. Test coverage verifies the connection check, document/contact/item preflight, historical preview, router evidence test, and webhook path do not reach a Xero mutation method.
5. Source code audit found no financial use of `createXero*`, `updateXero*`, `markXero*`, `convertPOsToBill`, `createHeartbeatJob`, or financial schedule enablement. The database helper rejects `enabled: true` for the financial schedules.

## 5. Read-only historical import preview

A **Historical Preview** tab now accepts up to 50 supplied references and matches only approved `A`, `S`, `H`, `JD`, `GD`, `I`, and `INV-` patterns using exact GET-only Xero reads.

- It **does not list or bulk copy** the Xero ledger.
- It does **not persist** preview rows.
- It labels unrecognised references as **Needs Review** and multiple matches as **Ambiguous**.
- It displays reference, inferred family, Xero document ID/number/status/party where found, preview timestamp, and a reconciliation note.

| Preview metric | Current result |
|---|---|
| Xero historical rows previewed | **0** — safely blocked before any Xero request because the AP token is expired |
| Matched | 0 |
| Unmatched | 0 |
| Ambiguous | 0 |
| Needs review | 0 |

## 6. Validation results

| Validation | Result |
|---|---|
| TypeScript | Passed (`npx tsc --noEmit`) |
| Targeted shadow/no-write tests | Passed — 5 files, 15 tests |
| Full AP regression suite | Passed — **38 files, 221 tests** |
| Production build | Passed (`pnpm build`) |
| Existing AP stability | Regression suite includes invoice/bill, PDF access/preview, supplier/Xero, email/Microsoft Graph, workflow monitoring, and VTiger transport-PO tests |

## 7. Required evidence before a future cutover decision

1. Re-authenticate AP Management's existing Xero connection through **Settings → Xero Integration**. Do not copy a token from Operations.
2. Supply a valid VTiger Webservice record ID (`moduleId x recordId`) for each named Deal or Container Control, starting with an Initial For Hire Container Control candidate.
3. Supply business-approved expected facts for each test branch: expected reference, party, account, item code, line description, quantity/rate, GST treatment, dates, and totals.
4. Run one **read-only** current-source test per branch from the Shadow Test Register and resolve any `held` / `failed` comparison before considering live cutover.
5. Run bounded historical previews for the named candidate references and review all unmatched/ambiguous rows.

## 8. Recommended first workflow family for later cutover

**Conditional recommendation only:** *Initial Container Control — For Hire PO*.

This remains the recommended first family because it has a narrow Draft-only PO proposal, a deterministic `H<Container Control>` reference, fixed account/item defaults, and no recurring scheduler dependency.

**No named live candidate is recommended yet.** A named candidate must first pass the source refresh, Xero preflight, and field-level test register comparison.

## 9. Later cutover action — not authorised

There is **no live financial writer URL** in AP Management. The only AP endpoint added is the shadow-only endpoint:

```text
/api/financial-workflows/shadow-events
```

It accepts only `mode=shadow` / `mode=dry_run` and cannot create Xero documents.

The current Operations writer URL and scheduled-writer identity were intentionally **not inspected or altered** in this phase. Therefore the exact later action is:

1. identify and document the exact existing Operations/VTiger writer URL or schedule with its owner;
2. obtain explicit approval naming the candidate, expected Xero reference, counterparty, amount, and Draft-only action;
3. disable that one old writer first; and only then
4. introduce a separately reviewed, document-specific AP Management live writer.

Do **not** perform any of these steps until this report is reviewed and explicit cutover approval is provided.
