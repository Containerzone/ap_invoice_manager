import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
describe("Deposit administrator workspace", () => {
	 it("keeps Deposit as an admin-only Financial Automations subtab outside Financial Operations", () => {
	   expect(source("client/src/components/DashboardLayout.tsx")).toMatch(/label: "Financial Automations", path: "\/financial-automation", adminOnly: true/);
	   expect(source("client/src/App.tsx")).toMatch(/<Route path="\/financial-automation">\s*<AdminGuard><FinancialAutomation \/><\/AdminGuard>/);
	   expect(source("client/src/App.tsx")).toMatch(/<Route path="\/deposit-invoices">\s*<Redirect to="\/financial-automation\?tab=deposit-invoices"/);
	   expect(source("client/src/pages/FinancialAutomation.tsx")).toContain('"deposit-invoices": <DepositInvoices />');
	   expect(source("client/src/lib/financialOperationsNavigation.ts")).not.toContain("deposit-invoices");
	 });
  it("uses only read-only query procedures and presents the excluded deductions/CRM updates", () => {
    const page = source("client/src/pages/DepositInvoices.tsx");
    expect(page).toContain("previewDepositInvoice.useQuery");
    expect(page).toContain("depositInvoiceEvents.useQuery");
    expect(page).not.toContain("useMutation");
    expect(page).toContain("strictly read-only");
    expect(page).toContain("never marks Deposit Status paid");
    expect(page).toContain("Deposit-to-main deductions and billing-party synchronization are");
    expect(page).toContain("separate Draft-only policies");
    const billing = source("client/src/components/BillingPartySyncPanel.tsx");
    expect(billing).toContain("previewBillingPartySync.useQuery");
    expect(billing).toContain("billingPartySyncEvents.useQuery");
    expect(billing).not.toContain("useMutation");
  });
});
