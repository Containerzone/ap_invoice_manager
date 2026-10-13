import { randomUUID } from "node:crypto";
import { readExtraHireFacts } from "./financialExtraHireInvoiceSource";
import {
  buildExtraHireInvoice,
  deriveExtraHireInvoiceNumber,
  EXTRA_HIRE_RULES_HASH,
  EXTRA_HIRE_RULES_VERSION,
  EXTRA_HIRE_SUFFIX_SCHEME,
} from "./financialExtraHireInvoiceRules";
import {
  readExtraHireXeroEvidence,
  type ExtraHireXeroEvidence,
} from "./financialExtraHireInvoiceXero";
import {
  assertExtraHireRelease,
  getExtraHireReleasePolicy,
} from "./financialExtraHireInvoiceRelease";
import {
  bindExtraHirePayload,
  claimExtraHireEvidence,
  completeExtraHireDraft,
  getExtraHireDealClaims,
  holdExtraHireExecution,
  recordExtraHireEvidence,
} from "./financialExtraHireInvoiceDb";
import {
  financialSha256,
  sourceSnapshotHash,
} from "./financialProposalIntegrity";
import { prepareFinancialDraftPayload } from "./financialProductionWriter";
import { executeGuardedFinancialWriterCommand } from "./financialWriterExecutionService";
import { readCurrentCustomerContactResolution } from "./financialCustomerContactSourceV2";
import { executeCustomerContactCreationV2, previewCustomerContactResolution, type CustomerContactPlan } from "./financialCustomerContactServiceV2";
export const EXTRA_HIRE_WEBHOOK_PATH =
  "/api/webhooks/vtiger/extra-hire-invoice";
export const EXTRA_HIRE_POSTCONDITION_HOLD =
  "Hire End Date +30 calendar days is a separate post-success boundary. No CRM action is queued by this readiness migration; a dedicated FINANCIAL_EXTRA_HIRE_POST_SUCCESS_ENABLED flag and separately implemented immutable conditional-write approval are required. Storage/global gates cannot open it.";
/** GET-only evidence and AP claims read; NEVER saves browser preview or infers live eligibility from extra_hire_runs. */
export async function previewExtraHireInvoice(
  dealId: string,
  expectedDealNumber?: string
) {
  const facts = await readExtraHireFacts(dealId);
  const policy = await getExtraHireReleasePolicy();
  const sourceHash = sourceSnapshotHash({
    ...facts,
    rulesVersion: EXTRA_HIRE_RULES_VERSION,
  });
  const preflightAt = new Date();
  let preflight: ExtraHireXeroEvidence | null = null;
  let ordinal: number | null = null;
  let number: string | null = null;
  let reason = facts.sourceHoldReason;
  let customerContactPlan: CustomerContactPlan | null = null;
  if (expectedDealNumber && facts.dealNumber !== expectedDealNumber)
    reason = "Current exact Deal does not match the named D-number requested.";
  if (
    !reason &&
    (facts.hireDuration !== 30 ||
      !facts.hireEndDate ||
      !facts.containerFeet ||
      !facts.customerName ||
      !facts.customerVtigerId)
  )
    reason =
      "Extra Hire requires duration 30, current end date, supported size/container and exact Deal customer.";
  if (!reason) {
    try {
      if (process.env.FINANCIAL_CUSTOMER_CONTACT_V2_ENABLED === "true") {
        customerContactPlan = await previewCustomerContactResolution(await readCurrentCustomerContactResolution(dealId));
        if (customerContactPlan.status === "held") reason = customerContactPlan.holdReason ?? "Xero customer-contact resolution is held.";
      }
      const contactOptions = customerContactPlan?.status === "matched" && customerContactPlan.contactId
        ? { contactOverride: { contactId: customerContactPlan.contactId, contactName: customerContactPlan.contactName ?? facts.customerName } }
        : customerContactPlan?.status === "would_create" ? { skipContactLookup: true } : {};
      if (reason) throw new Error(reason);
      const claims = await getExtraHireDealClaims(dealId);
      const initial = await readExtraHireXeroEvidence(
        facts.dealNumber,
        facts.customerName,
        facts.containerFeet!,
        undefined,
        contactOptions
      );
      const suffix = deriveExtraHireInvoiceNumber(
        facts.dealNumber,
        facts.hireEndDate!,
        initial.history,
        claims,
        policy.invoiceSuffixCollisionSchemeConfirmed &&
          policy.suffixScheme === EXTRA_HIRE_SUFFIX_SCHEME
      );
      reason = suffix.holdReason;
      ordinal = suffix.ordinal;
      number = suffix.invoiceNumber;
      // Also read exact candidate number independently. No filtered/active-only historical helper is used.
      preflight = number
        ? await readExtraHireXeroEvidence(
            facts.dealNumber,
            facts.customerName,
            facts.containerFeet!,
            number,
            contactOptions
          )
        : initial;
      if (
        number &&
        financialSha256({ ...initial, exactCandidateMatches: [] }) !==
          financialSha256(preflight)
      )
        reason =
          "Xero evidence changed during Extra Hire preview; refresh, never infer a free suffix.";
    } catch (e) {
      reason =
        e instanceof Error
          ? e.message
          : "Extra Hire current Xero/claim evidence unavailable.";
    }
  }
  const preview = buildExtraHireInvoice(
    facts,
    number,
    preflight?.item ?? null,
    policy.dateSemantics
  );
  if (preview.document && preflight)
    preview.document.partySourceId = preflight.contactId;
  reason = reason ?? (customerContactPlan?.status === "would_create" ? "Xero customer contact is absent; preview proposes one guarded contact creation and no Draft write." : null) ?? preview.holdReason;
  return {
    facts,
    sourceSnapshotHash: sourceHash,
    rulesSnapshotHash: EXTRA_HIRE_RULES_HASH,
    xeroPreflightHash: preflight ? financialSha256(preflight) : null,
    preflightAt,
    ordinal,
    preview: reason
      ? { ...preview, eligible: false, holdReason: reason }
      : preview,
    preflight,
    state: reason ? ("held" as const) : ("previewed" as const),
    holdReason: reason,
    customerContactPlan,
    postconditionHold: EXTRA_HIRE_POSTCONDITION_HOLD,
    noWrites: true as const,
  };
}
export async function processAutomaticExtraHireInvoice(dealId: string) {
  const policy = await getExtraHireReleasePolicy();
  assertExtraHireRelease(policy);
  let result = await previewExtraHireInvoice(dealId);
  let customerContactWrites = 0;
  let contactCreationHold: string | null = null;
  if (process.env.FINANCIAL_CUSTOMER_CONTACT_V2_ENABLED === "true" && result.customerContactPlan?.status === "would_create") {
    const created = await executeCustomerContactCreationV2(result.customerContactPlan);
    customerContactWrites = created.contactWritesAttempted;
    if (created.status === "matched" || created.status === "created") result = await previewExtraHireInvoice(dealId);
    else contactCreationHold = created.holdReason ?? "Customer contact creation remains held by its independent release gate.";
  }
  let reason = result.holdReason;
  if (contactCreationHold) reason = contactCreationHold;
  if (
    !result.facts.sourceRefreshedAt ||
    Date.parse(result.facts.sourceRefreshedAt) <
      Date.parse(policy.effectiveFrom!)
  )
    reason =
      "Extra Hire current Deal predates the approved new-events-only cutover.";
  if (
    financialSha256(result.facts.mappingEvidence) !== policy.sourceMappingsHash
  )
    reason =
      "Current exact Extra Hire mappings differ from the approved source mappings.";
  const event = await recordExtraHireEvidence({
    evidenceKey: financialSha256({
      source: result.sourceSnapshotHash,
      preflight: result.xeroPreflightHash,
      ordinal: result.ordinal,
      reason,
    }),
    dealId,
    dealNumber: result.facts.dealNumber || dealId,
    sourceHireEndDate: result.facts.hireEndDate,
    ordinal: result.ordinal,
    proposedInvoiceNumber: result.preview.proposedInvoiceNumber,
    customerName: result.facts.customerName || null,
    sourceRefreshedAt: result.facts.sourceRefreshedAt
      ? new Date(result.facts.sourceRefreshedAt)
      : null,
    preflightAt: result.preflightAt,
    sourceSnapshotHash: result.sourceSnapshotHash,
    rulesSnapshotHash: EXTRA_HIRE_RULES_HASH,
    xeroPreflightHash: result.xeroPreflightHash,
    sourceSnapshot: result.facts,
    proposal: result.preview.document,
    xeroPreflight: result.preflight,
    status: reason ? "held" : "previewed",
    holdReason: reason,
    postconditionHold: EXTRA_HIRE_POSTCONDITION_HOLD,
  });
  if (reason || !result.preview.document)
    return {
      ok: false,
      status: "held",
      recordId: dealId,
      eventId: event.id,
      warning: reason,
      xeroWritesAttempted: customerContactWrites,
    };
  const token = randomUUID();
  if (!(await claimExtraHireEvidence(event.id, token, policy.releaseKey)))
    return {
      ok: false,
      status: "held",
      recordId: dealId,
      eventId: event.id,
      warning:
        "Exact Extra Hire source period/ordinal already claimed, uncertain, or preflight stale. No replay creates a second invoice.",
      xeroWritesAttempted: customerContactWrites,
    };
  try {
    const payload = prepareFinancialDraftPayload(
      result.preview.document,
      `${dealId}:extra_hire:${result.facts.hireEndDate}:${result.ordinal}:${result.sourceSnapshotHash}`
    );
    (payload.body.Invoices as any[])[0].CurrencyCode = "AUD";
    await bindExtraHirePayload(event.id, token, payload);
    const outcome = await executeGuardedFinancialWriterCommand({
      workflowType: "extra_hire",
      proposedAction: "create_draft",
      payload,
      preparedBy: policy.approvedBy!,
      expectedDraftDocument: result.preview.document,
      authorisation: {
        workflowType: "extra_hire",
        approvalReference: policy.releaseKey,
        globalShadowMode: false,
        familyLiveEnabled: true,
        releaseManifestApproved: true,
        cutoverPackApproved: true,
        currentDocumentPreflightPassed: true,
        legacyWriterHandoffComplete: true,
        extraHireAutomaticEventId: event.id,
        extraHireReleaseKey: policy.releaseKey,
        extraHireApprovedBy: policy.approvedBy!,
      },
    });
    if (outcome.outcome !== "succeeded") {
      await holdExtraHireExecution(
        event.id,
        "Extra Hire Xero execution requires exact reconciliation. No blind retry, suffix skip or CRM action."
      );
      return {
        ok: false,
        status: "reconciliation_required",
        recordId: dealId,
        eventId: event.id,
        warning: "Extra Hire exact execution receipt needs reconciliation.",
      };
    }
    await completeExtraHireDraft(
      event.id,
      token,
      outcome.executionId,
      outcome.result.xeroDocumentId
    );
    return {
      ok: true,
      status: "drafts_created",
      recordId: dealId,
      eventId: event.id,
      invoiceNumber: outcome.result.documentNumber,
      xeroInvoiceId: outcome.result.xeroDocumentId,
      xeroWritesAttempted: customerContactWrites + 1,
      postconditionHold: EXTRA_HIRE_POSTCONDITION_HOLD,
    };
  } catch (e) {
    await holdExtraHireExecution(
      event.id,
      e instanceof Error ? e.message : "Extra Hire execution held."
    );
    throw e;
  }
}
export async function getExtraHireReadiness() {
  const policy = await getExtraHireReleasePolicy();
  let releaseHoldReason: string | null = null;
  try {
    assertExtraHireRelease(policy);
  } catch (e) {
    releaseHoldReason =
      e instanceof Error ? e.message : "Extra Hire release disabled.";
  }
  return {
    webhookPath: EXTRA_HIRE_WEBHOOK_PATH,
    routeRegistered: true,
    webhookAuthenticationConfigured: Boolean(
      process.env.FINANCIAL_AP_WEBHOOK_SECRET?.trim()
    ),
    writerEnabled: !releaseHoldReason,
    policy,
    releaseHoldReason,
    postSuccessEnabled: false,
    postconditionHold: EXTRA_HIRE_POSTCONDITION_HOLD,
    noWrites: true as const,
  };
}
