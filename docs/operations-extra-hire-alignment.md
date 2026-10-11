# Operations alignment — Extra Hire invoice migration

## Authorised legacy handover reference

The historical Operations writer identified for this family is:

> `POST https://supplycrm-7kuu33x8.manus.space/api/webhooks/vtiger-extra-hire-invoice`

Its VTiger trigger is described as **Extend Hire Duration Invoice Automation Webhook**. This AP implementation does not modify that webhook, its VTiger action, its Make scenario or its schedule.

## Verified source metadata

A bounded authenticated VTiger **Potentials metadata describe** was performed on 11 October 2026. No Deal/customer record was retrieved for implementation. The AP source resolver re-checks these exact labels and types on every preview/execution and holds on drift:

| Business fact | Current VTiger label | Verified API field | Expected type / use |
|---|---|---|---|
| Deal number | Deal ID | `potential_no` | String D-number |
| Container number | Container number | `potentialname` | String |
| Container type | Container Type | `cf_potentials_containertype` | Picklist; only listed 20/40 sizes accepted |
| Hire duration | Hire Duration | `cf_potentials_howlongwouldyouliketohirefor` | Picklist; only `30 days` accepted |
| Hire end | Hire End Date | `cf_potentials_hireenddate` | ISO date |
| Organisation | Organization Name | `related_to` | Accounts reference, preferred customer |
| Contact | Contact Name | `contact_id` | Contacts reference only when organisation is blank |
| Freshness | Modified Time | `modifiedtime` | Offset-bearing datetime required |

## Compatibility and intentional safety changes

The AP draft preserves the legacy commercial calculation: one 4.286-week, GST-exclusive customer invoice line using 20- or 40-foot Extra Hire item/rate evidence and account 210 only where Xero current sales evidence confirms it.

The historical `-D` style cannot be reused: it conflicts with the separately controlled Deposit family. AP therefore requires a separately approved, contiguous `EH_AP_ORDINAL_V1` series. It never imports, adopts or increments around existing Operations/Xero history. A hold is returned until that revision policy is explicitly accepted.

The legacy post-success Hire End Date extension (+30 calendar days) is intentionally excluded from this migration. AP invoices are never proof that it is safe to revise current VTiger state; a separate conditional-write design, immutable queue and document-specific approval are required.

## No external handover performed

No Operations writer, VTiger action, Make scenario, webhook URL, schedule, Xero document or CRM record was changed while preparing this AP-only capability.
