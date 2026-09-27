
## Authentication transport correction — 27 September 2026

The Phase 1.7 implementation initially described VTiger authentication as GET-only. That was too strict and did not match VTiger's documented legacy webservice contract. The [official VTiger REST webservice documentation](https://community.vtiger.com/help/vtigercrm/developers/third-party-app-integration.html) requires:

1. `GET` `getchallenge` for a short-lived challenge token;
2. `POST` `application/x-www-form-urlencoded` `login` with `accessKey = MD5(challengeToken + userAccessKey)`; then
3. `GET` exact-query/retrieve operations for source discovery.

The AP implementation has been corrected to use that form-login transport only. The login POST creates an in-memory session and **does not create, edit or delete a VTiger record**, alter a workflow URL, or invoke Xero.

**Revalidation with the unchanged AP Management credential passed.** An exact, read-only lookup for Deal **D702903** then uniquely found VTiger record `5x486152` through the verified `Potentials.potential_no` (Deal ID) field. The record identifies container `SCFU2217390` and was last modified at `2026-09-26 23:40:31`. No financial workflow, Candidate Roster row, Xero document or VTiger record was created or changed.

The former candidate query had also projected custom fields that do not exist on this VTiger instance. Its default projection is now limited to metadata-verified Potentials fields: `id`, `potential_no`, `potentialname` and `modifiedtime`.
