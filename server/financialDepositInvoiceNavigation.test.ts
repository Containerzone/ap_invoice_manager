import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
describe("Deposit standalone administrator workspace", () => {
  it("registers a separate administrator sidebar page outside Financial Operations", () => {
    expect(source("client/src/components/DashboardLayout.tsx")).toMatch(/label: "Deposit Invoices", path: "\/deposit-invoices", adminOnly: true/);
    expect(source("client/src/App.tsx")).toMatch(/<Route path="\/deposit-invoices">\s*<AdminGuard><DepositInvoices \/><\/AdminGuard>/);
    expect(source("client/src/lib/financialOperationsNavigation.ts")).not.toContain("deposit-invoices");
  });
  it("uses only read-only query procedures and presents the excluded deductions/CRM updates", () => {
    const page = source("client/src/pages/DepositInvoices.tsx");
    expect(page).toContain("previewDepositInvoice.useQuery");
    expect(page).toContain("depositInvoiceEvents.useQuery");
    expect(page).not.toContain("useMutation");
    expect(page).toContain("strictly read-only");
    expect(page).toContain("never marks Deposit Status paid");
    expect(page).toContain("Main-invoice negative deposit deductions remain a separate held");
  });
});
