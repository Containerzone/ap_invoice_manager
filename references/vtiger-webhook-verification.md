# VTiger Webhook Capability Verification

**Checked:** 29 September 2026

VTiger publishes an official workflow-webhook action. This supports the architecture in the AP-only Financial Operations packet: a VTiger workflow can issue an HTTP webhook to an AP endpoint after the AP-side endpoint has been published and is ready for dry-run use.

- Official documentation: [Automation - Webhook Workflow](https://help.vtiger.com/article/146775672-Automation---Workflow-action---Webhook)
- Search validation: the official document describes a workflow webhook action; the current packet’s HTTP POST route design is therefore technically compatible with VTiger’s workflow-webhook capability.

**Scope boundary:** This verification does not change VTiger. AP Management will expose authenticated, disabled-by-default routes only. No VTiger URL, header, workflow condition or action is changed until an approved, family-specific external cutover.
