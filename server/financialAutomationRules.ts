export type FinancialAutomationRules = {
  accounts: {
    acquisition: string;
    initialHire: string;
    recurringHire: string;
    jdTransport: string;
    gdStorage: string;
    extraHire: string;
    avisoWarranty: string;
  };
  itemCodes: {
    acquisitionAsset: string;
    acquisitionCustomerSale: string;
    initialHire20: string;
    initialHire40: string;
    recurringHire20: string;
    recurringHire40: string;
    jd20: string;
    jd40: string;
    gd20: string;
    gd40: string;
    deposit: string;
    overweight: string;
    extraHire20: string;
    extraHire40: string;
  };
  rates: {
    initialHire20MonthlyExGst: number;
    initialHire40MonthlyExGst: number;
    storageCustomer20Weekly: number;
    storageCustomer40Weekly: number;
    storageSupplier20WeeklyExGst: number;
    storageSupplier40WeeklyExGst: number;
    storageTransport20ExGst: number;
    storageTransport40ExGst: number;
    extraHire20WeeklyExGst: number;
    extraHire40WeeklyExGst: number;
  };
  defaults: {
    gstRatePercent: number;
    recurringHireDays: number;
    extraHireWeeks: number;
    recurringHireCadence: string;
    recurringStorageCadence: string;
  };
  warranty: {
    supplierName: string;
    accountCode: string;
  };
  validation: {
    allowedRecurringHireStatuses: string[];
    recurringHireAcquisition: string;
    mainInvoiceDraftStatus: string;
  };
};

/**
 * Financial workflow defaults are named and centrally visible. They are applied
 * to each evaluator and can be overridden only via the AP app's non-secret,
 * audited financial-automation.rules configuration record.
 */
export const DEFAULT_FINANCIAL_AUTOMATION_RULES: FinancialAutomationRules = {
  accounts: {
    acquisition: "322",
    initialHire: "312",
    recurringHire: "312",
    jdTransport: "310",
    gdStorage: "311",
    extraHire: "210",
    avisoWarranty: "313",
  },
  itemCodes: {
    acquisitionAsset: "Container Asset",
    acquisitionCustomerSale: "Container Sale",
    initialHire20: "HC 20",
    initialHire40: "HC 40",
    recurringHire20: "HC 20 E",
    recurringHire40: "HC 40 E",
    jd20: "JD 20",
    jd40: "JD 40",
    gd20: "GD 20",
    gd40: "GD 40",
    deposit: "Deposit Required",
    overweight: "SER70",
    extraHire20: "20' Hire",
    extraHire40: "40' Hire",
  },
  rates: {
    initialHire20MonthlyExGst: 120,
    initialHire40MonthlyExGst: 240,
    storageCustomer20Weekly: 65,
    storageCustomer40Weekly: 95,
    storageSupplier20WeeklyExGst: 50,
    storageSupplier40WeeklyExGst: 70,
    storageTransport20ExGst: 275,
    storageTransport40ExGst: 375,
    extraHire20WeeklyExGst: 45,
    extraHire40WeeklyExGst: 70,
  },
  defaults: {
    gstRatePercent: 10,
    recurringHireDays: 30,
    extraHireWeeks: 4.286,
    recurringHireCadence: "0 0 0 1 * *",
    recurringStorageCadence: "0 0 0 1 * *",
  },
  warranty: { supplierName: "Aviso Broking Pty Ltd", accountCode: "313" },
  validation: {
    allowedRecurringHireStatuses: ["ON HIRE", "IDLE"],
    recurringHireAcquisition: "FOR HIRE",
    mainInvoiceDraftStatus: "DRAFT",
  },
};

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function mergeKnown<T extends UnknownRecord>(base: T, candidate: unknown): T {
  if (!isRecord(candidate)) return clone(base);
  const merged: UnknownRecord = clone(base);
  for (const [key, value] of Object.entries(candidate)) {
    if (!(key in base) || value === undefined) continue;
    const current = base[key as keyof T];
    if (isRecord(current) && isRecord(value)) {
      merged[key] = mergeKnown(current, value);
    } else if (Array.isArray(current) && Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
      merged[key] = value.map((entry) => entry.trim()).filter(Boolean);
    } else if (typeof current === "number" && typeof value === "number" && Number.isFinite(value)) {
      merged[key] = value;
    } else if (typeof current === "string" && typeof value === "string" && value.trim()) {
      merged[key] = value.trim();
    }
  }
  return merged as T;
}

export function resolveFinancialAutomationRules(override?: unknown): FinancialAutomationRules {
  return mergeKnown(DEFAULT_FINANCIAL_AUTOMATION_RULES, override);
}

/** Keys intentionally supported by the configuration screen. Secrets never appear here. */
export const FINANCIAL_AUTOMATION_RULE_CONFIG_KEY = "financial-automation.rules";
export const FINANCIAL_VTIGER_SOURCE_MAPPING_CONFIG_KEY = "financial-automation.vtiger-source-mapping";
