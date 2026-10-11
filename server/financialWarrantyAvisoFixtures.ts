// SYNTHETIC TEST FIXTURES ONLY. Not production-approved labels, mapping, price or Xero evidence.
import { financialSha256 } from "./financialProposalIntegrity";
import { resolveWarrantyRelease, warrantySourceConfigHash, WARRANTY_RELEASE_KEY } from "./financialWarrantyAvisoRelease";
import { AVISO_NAME, WARRANTY_RULES_HASH, buildWarrantyPlan, type FieldBinding, type WarrantyFacts, type WarrantySourceConfig, type WarrantyXeroEvidence } from "./financialWarrantyAvisoRules";
const field = (name: string, label: string, type: string, extra: Record<string, unknown> = {}): FieldBinding => ({ name, label, type: { name: type, ...extra }, mandatory: false });
export function warrantyFixture() {
  const config: WarrantySourceConfig = { module: "Potentials", potentialsIdPrefix: "5", fields: {
    dealNumber: field("potential_no", "Deal ID", "string"), addedServices: field("cf_test_added", "Added Services", "picklist", { picklistValues: [{ value: "Synthetic Warranty" }, { value: "No warranty" }] }),
    organisation: field("related_to", "Organization Name", "reference", { refersTo: ["Accounts"] }), contact: field("contact_id", "Contact Name", "reference", { refersTo: ["Contacts"] }),
    modifiedTime: field("modifiedtime", "Modified Time", "datetime"), issueDate: null, dueDate: null },
    customerFields: { organisation: { name: field("accountname", "Organization Name", "string"), modifiedTime: field("modifiedtime", "Modified Time", "datetime") },
      contact: { firstName: field("firstname", "First Name", "string"), lastName: field("lastname", "Last Name", "string"), modifiedTime: field("modifiedtime", "Modified Time", "datetime") } },
    dateSemantics: { issue: "preserve_main_date", due: "preserve_main_due_date" },
    addedServicesMappings: [{ addedServicesValue: "Synthetic Warranty", itemCode: "WAR-TEST", nativeDescription: "Synthetic native warranty", premiumExGst: 100 }] };
  const facts: WarrantyFacts = { dealId: "5x77", dealNumber: "D77", addedServices: "Synthetic Warranty", customerVtigerId: "4x9", customerName: "Synthetic Customer", customerKind: "organisation",
    sourceModifiedAt: "2026-10-01T00:00:00.000Z", customerModifiedAt: "2026-10-01T00:00:00.000Z", issueDate: null, dueDate: null, sourceMappingsHash: warrantySourceConfigHash(config),
    addedServicesMappingHash: financialSha256(config.addedServicesMappings), mapping: config.addedServicesMappings[0], configurationRequired: [], holdReason: null };
  const customer = { ContactID: "customer-id", Name: facts.customerName, ContactStatus: "ACTIVE" }; const supplier = { ContactID: "aviso-id", Name: AVISO_NAME, ContactStatus: "ACTIVE" };
  const main = { InvoiceID: "main-id", InvoiceNumber: "INV-77", Type: "ACCREC", Status: "DRAFT", Contact: { ContactID: customer.ContactID, Name: customer.Name }, CurrencyCode: "AUD", LineAmountTypes: "Exclusive", Date: "2026-10-01", DueDate: "2026-10-15", Reference: "Preserve reference", SubTotal: 200, TotalTax: 20, Total: 220, AmountPaid: 0,
    LineItems: [{ LineItemID: "line-1", ItemCode: "SERVICE", Description: "Keep every field", Quantity: 2, UnitAmount: 100, AccountCode: "200", TaxType: "OUTPUT", LineAmount: 200, TaxAmount: 20, Tracking: [{ TrackingCategoryID: "category-id", TrackingOptionID: "option-id" }] }] };
  const evidence: WarrantyXeroEvidence = { tenantId: "synthetic-tenant", mainHistory: [{ InvoiceID: main.InvoiceID, InvoiceNumber: main.InvoiceNumber, Status: "DRAFT", Type: "ACCREC" }], main, otherInvoices: [], poHistory: [], purchaseOrders: [], customer, supplier,
    item: { Code: "WAR-TEST", Description: "Synthetic native warranty", PurchaseDescription: "Synthetic native warranty", IsSold: true, IsPurchased: true,
      SalesDetails: { UnitPrice: 100, AccountCode: "200", TaxType: "OUTPUT" }, PurchaseDetails: { UnitPrice: 100, AccountCode: "313", TaxType: "INPUT" } },
    accounts: [{ Code: "200", Status: "ACTIVE", TaxType: "OUTPUT", Type: "REVENUE" }, { Code: "313", Status: "ACTIVE", TaxType: "INPUT", Type: "EXPENSE" }],
    taxes: [{ TaxType: "INPUT", Status: "ACTIVE", EffectiveRate: 10 }, { TaxType: "OUTPUT", Status: "ACTIVE", EffectiveRate: 10 }], configurationHash: "a".repeat(64), comparisonHash: "b".repeat(64), historyComplete: true };
  const policy = resolveWarrantyRelease({ enabled: true, releaseKey: WARRANTY_RELEASE_KEY, rulesHash: WARRANTY_RULES_HASH, approvedBy: 7, approvedAt: "2026-09-30T00:00:00Z", effectiveFrom: "2026-09-30T00:00:00Z",
    migrationScope: "new_events_only", warrantyOnlyVtigerBranch: true, operationsMakeHandoverAcknowledged: true, mainInvoiceCoordinationAcknowledged: true, isolatedDraftOnlyScope: true,
    draftAmendmentAcknowledged: true, enableDraftMainAmendment: true, sourceConfig: config, sourceMappingsHash: facts.sourceMappingsHash, addedServicesMappingHash: facts.addedServicesMappingHash,
    xeroConfigurationHash: evidence.configurationHash, avisoSupplierName: AVISO_NAME, avisoAccountCode: "313", avisoContactId: supplier.ContactID, noCrmPostSuccessMutation: true });
  const plan = buildWarrantyPlan(facts, evidence, config);
  const reservation: any = { id: 8, createdAt: new Date(), status: "reserved", claimKey: "warranty:D77", eventKey: "synthetic-reserve", executionGroup: "group-id", dealId: facts.dealId, dealNumber: facts.dealNumber, releaseKey: policy.releaseKey, approvedBy: 7,
    sourceSnapshot: facts, sourceSnapshotHash: financialSha256(facts), xeroPreflight: evidence, xeroPreflightHash: financialSha256(evidence), proposal: plan,
    authorisedPayload: { policyHash: financialSha256(policy), main: plan.mainPayload, po: plan.poPayload, mainHash: financialSha256(plan.mainPayload), poHash: financialSha256(plan.poPayload), expectedMain: plan.expectedMain, expectedPo: plan.expectedPo } };
  return { config, facts, evidence, plan, policy, reservation };
}
