import { useLocation } from "wouter";
import { Landmark, Workflow } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import {
  FINANCIAL_AUTOMATION_TABS,
  financialAutomationPath,
  financialAutomationTabFromSearch,
  type FinancialAutomationTab,
} from "@/lib/financialAutomationNavigation";
import StorageAutomation from "./StorageAutomation";
import ContainerHirePos from "./ContainerHirePos";
import ContainerAssetPos from "./ContainerAssetPos";
import ContainerCustomerSalePos from "./ContainerCustomerSalePos";
import MainCustomerInvoices from "./MainCustomerInvoices";
import DepositInvoices from "./DepositInvoices";
import FinalWeightAdjustments from "./FinalWeightAdjustments";
import ExtraHireInvoices from "./ExtraHireInvoices";
import WarrantyAviso from "./WarrantyAviso";
import { CustomerContactAuditPanel } from "@/components/CustomerContactAuditPanel";

const WORKSPACE_CONTENT: Record<FinancialAutomationTab, React.ReactNode> = {
  storage: <StorageAutomation />,
  "hire-pos": <ContainerHirePos />,
  "asset-pos": <ContainerAssetPos />,
  "customer-sale-pos": <ContainerCustomerSalePos />,
  "main-invoices": <MainCustomerInvoices />,
  "deposit-invoices": <DepositInvoices />,
  "final-weight": <FinalWeightAdjustments />,
  "extra-hire": <ExtraHireInvoices />,
  "warranty-aviso": <WarrantyAviso />,
};

export default function FinancialAutomation() {
  const [location, setLocation] = useLocation();
  const tab = financialAutomationTabFromSearch(
    location.includes("?") ? location.slice(location.indexOf("?")) : window.location.search
  );

  return (
    <div className="space-y-5 pb-12">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <Landmark className="h-6 w-6" /> Financial Automations
          </h1>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
            One workspace for every VTiger-to-Xero financial workflow. Select a subtab to review its current source evidence, release state and AP tracking.
          </p>
        </div>
        <Badge variant="outline" className="gap-1.5">
          <Workflow className="h-3.5 w-3.5" /> Admin workspace
        </Badge>
      </header>

      <CustomerContactAuditPanel />

      <Tabs
        value={tab}
        onValueChange={(value) => setLocation(financialAutomationPath(value as FinancialAutomationTab))}
        className="space-y-5"
      >
        <div className="overflow-x-auto rounded-xl border bg-card p-2 shadow-sm">
          <TabsList className="h-auto w-max min-w-full justify-start gap-1 bg-transparent p-0">
            {FINANCIAL_AUTOMATION_TABS.map((item) => (
              <TabsTrigger
                key={item.value}
                value={item.value}
                className="h-auto min-w-36 flex-col items-start gap-1 whitespace-nowrap rounded-lg px-3 py-2.5 text-left text-xs data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
              >
                <span className="font-medium">{item.label}</span>
                <span className="max-w-44 whitespace-normal text-[10px] leading-snug opacity-70 data-[state=active]:opacity-85">
                  {item.description}
                </span>
              </TabsTrigger>
            ))}
          </TabsList>
        </div>

        {FINANCIAL_AUTOMATION_TABS.map((item) => (
          <TabsContent key={item.value} value={item.value} className="mt-0 focus-visible:outline-none">
            {WORKSPACE_CONTENT[item.value]}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
