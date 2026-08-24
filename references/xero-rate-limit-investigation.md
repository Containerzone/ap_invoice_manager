# Xero Rate-Limit Investigation

## Official Xero limits

Source: https://developer.xero.com/documentation/best-practices/api-call-efficiencies/rate-limits/

- Limits apply per tenant/app connection over a rolling 24-hour period.
- Concurrent limit: 5 calls in progress.
- Tenant minute limit: 60 calls per minute.
- Tenant daily limit: 1,000 calls/day on Starter and 5,000 calls/day on higher tiers.
- App-wide minute limit: 10,000 calls/minute across tenants.
- Xero returns rate-limit response headers on API calls.
- HTTP 429 includes `Retry-After`; Xero instructs clients to pause requests to that tenant for the specified period.
- Xero recommends caching, filtering, pagination, `If-Modified-Since`, reducing polling, and waiting before retries.

The official OAuth limits guide states that every response contains `X-DayLimit-Remaining`, `X-MinLimit-Remaining`, and `X-AppMinLimit-Remaining`. A 429 also contains `X-Rate-Limit-Problem`, identifying the exhausted limit, and `Retry-After` for minute or daily exhaustion. Xero explicitly instructs integrations to pause **all requests to that tenant** until the stated time rather than retrying only the failed call.

Source: https://developer.xero.com/documentation/guides/oauth2/limits/

Xero's caching guidance recommends retrieving frequently used records once, retaining them locally with a timestamp, and serving subsequent reads from that cache. This directly applies to repeated PO verification, duplicate-bill checks, supplier searches and payment-status lookups in this application.

Source: https://developer.xero.com/documentation/best-practices/api-call-efficiencies/caching-data

Xero supports an `Idempotency-Key` header on POST, PUT and PATCH operations. Xero caches the response for six minutes so a retried mutation cannot create a duplicate. The same key must be retained for every retry of the same request. Rate-limit checks occur before idempotency checks, so idempotency alone does not reduce calls; it makes queued/retried writes safe.

Source: https://developer.xero.com/documentation/guides/idempotent-requests/idempotency

## Application evidence captured 24 August 2026

- `DD702810` and `TR702819` both returned HTTP 429 during direct read-only lookup.
- Dry Creek Storage contact resolution also returned 429 even though the supplier already had a saved Xero Contact ID.
- Existing code issued Xero requests independently with no shared per-tenant queue, daily-budget awareness, in-flight request deduplication, or shared read cache.
- The previous bill retry was local to invoice creation only, so it could not prevent continued 429s caused by aggregate requests across verify, approve, supplier search, duplicate checks, PO conversion, PO status updates, payment checks and attachments.

## Decisive live response

A read-only lookup for `DD702810` returned the following Xero headers:

| Header | Value |
|---|---:|
| `X-Rate-Limit-Problem` | `day` |
| `Retry-After` | `73451` seconds |
| `X-MinLimit-Remaining` | `60` |
| `X-DayLimit-Remaining` | `0` |

This proves the account has exhausted its **daily tenant allowance**, not the 60-per-minute limit. The indicated reset was approximately 20 hours and 24 minutes away at the time of the check. Short retries after one or two seconds cannot fix a daily-limit exhaustion and only consume application work while Xero continues rejecting the tenant.

## Root cause in the application

The integration had no central per-tenant request manager. Each workflow issued its own calls independently. A normal PO-backed invoice could trigger repeated reads of the same PO during verification, approval, post-approval refresh, bill conversion and final PO status update. Supplier matching, duplicate-bill checks, payment checks and attachment upload added further calls. There was no shared GET cache, no in-flight deduplication, no tenant-wide pause state, no remaining-budget tracking, and no reuse of Xero responses between workflow stages. The earlier 429 retry applied only to the final bill POST and therefore could not reduce total daily consumption.

## Permanent control design

| Control | Purpose |
|---|---|
| Persisted tenant pause | Save `Retry-After`, exhausted-limit type and remaining allowances against the Xero connection so all application instances stop before contacting Xero again. |
| Central request gate | Serialize API calls for the connected tenant and apply a conservative minimum interval, keeping concurrency below five and traffic safely below 60 calls/minute. |
| Shared response-header tracking | Read the remaining minute/day budgets from every response and update connection state before the next workflow starts. |
| In-flight GET deduplication | If two requests ask for the same PO/contact/bill simultaneously, issue one Xero request and share the result. |
| Short-lived database cache | Reuse recently retrieved PO, contact and bill data across verify, approve, refresh and resolve instead of re-fetching unchanged resources. |
| Mutation invalidation | Invalidate affected cache entries after creating or updating a bill, contact or PO so subsequent reads do not use stale data. |
| Idempotent writes | Send a stable `Idempotency-Key` on retried POST/PUT operations to prevent duplicate Xero records. |

## Implemented and validated

The completed change adds persisted per-tenant pause and remaining-budget fields to the Xero connection, plus a shared `xero_api_cache` table. Every Xero Accounting API request in both invoice processing and Vtiger Stage 1 PO automation now passes through one request gate. The gate serialises calls, keeps a conservative 1.1-second interval, stores every response's remaining budgets, immediately persists 429 reset instructions, and blocks all further network calls until the tenant pause expires.

PO, contact and invoice-number reads now use shared database caching and in-flight deduplication. Verified PO data is reused by approval, post-approval refresh, bill conversion and BILLED status updates. Mutations invalidate affected cache entries. Xero POST/PUT requests include deterministic idempotency keys so retried writes do not create duplicate records.

The active CONTAINERZONE tenant pause was persisted with `problem=day`, `dayRemaining=0`, `minuteRemaining=60`, and a reset time of 25 August 2026 at approximately 10:10 am. The Settings page now shows this exact pause rather than prompting users to repeatedly retry. TypeScript validation passed, all 105 Vitest tests passed, and the rendered Settings page and browser/server logs showed no runtime errors.
