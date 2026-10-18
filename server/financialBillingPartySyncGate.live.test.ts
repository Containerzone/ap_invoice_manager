import { describe, expect, it } from "vitest";
import {
  BILLING_PARTY_SYNC_RULES_HASH,
  getBillingPartySyncReadiness,
} from "./financialBillingPartySyncService";

describe.runIf(process.env.RUN_BILLING_PARTY_SYNC_READINESS_TEST === "true")(
  "billing-party sync live readiness gate",
  () => {
    it("reports the approved read-only runtime readiness contract", async () => {
      const readiness = await getBillingPartySyncReadiness();

      expect(readiness.runtimeEnabled).toBe(true);
      expect(readiness.writerEnabled).toBe(true);
      expect(readiness.releaseHoldReason).toBeNull();
      expect(readiness.migrationScope).toBe("new_events_only");
      expect(readiness.rulesHash).toBe(BILLING_PARTY_SYNC_RULES_HASH);
      expect(readiness.noWrites).toBe(true);
      expect(readiness.apOwnedMainReceiptOnly).toBe(true);
      expect(readiness.policy).toMatchObject({
        releaseKey: "financial-automation.billing-party-sync-release",
        rulesHash: BILLING_PARTY_SYNC_RULES_HASH,
        migrationScope: "new_events_only",
        apOwnedMainReceiptOnly: true,
        exactDraftContactIdOnly: true,
        sourceRevalidationRequired: true,
        tenantBound: true,
        preservationReadbackRequired: true,
      });
      expect(process.env.FINANCIAL_CUSTOMER_CONTACT_V2_ENABLED).toBe("true");
      expect(process.env.FINANCIAL_CUSTOMER_CONTACT_AUTOMATIC_ENABLED).toBe("true");
    });
  },
);
