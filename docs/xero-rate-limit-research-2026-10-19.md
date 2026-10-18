# Xero rate-limit research — 19 October 2026

Xero describes HTTP 429 as the organisation/application connection exceeding an API rate limit. Its official Accounting API response documentation identifies 429 as “Rate Limit Exceeded.” The rate-limit guidance says a 429 response includes `Retry-After` and `X-Rate-Limit-Problem`, and requests should pause for that period before another attempt. Xero states tenant limits include a five-concurrent-call limit, 60 calls per minute, and a tier-dependent daily limit (1,000 starter / 5,000 higher tiers). The relevant limit is per tenant/app connection, so independent concurrent integrations can contribute.

For AP financial Drafts, the safe implication is that 429 must not be treated as a successful document creation. It must be recorded, current Xero evidence checked after the pause, and an exact current recovery/approval required before any new POST; a blanket webhook retry is not a safe financial control. In-process tenant pacing reduces this application's contribution but cannot control traffic from other integrations or instances.

## Sources

- https://developer.xero.com/documentation/best-practices/api-call-efficiencies/rate-limits — Xero Rate Limits: tenant limits, rate-limit response headers and Retry-After guidance.
- https://developer.xero.com/documentation/api/accounting/responsecodes — Xero Accounting API HTTP response codes, including 429 Rate Limit Exceeded.
