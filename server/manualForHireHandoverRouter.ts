import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { router, protectedProcedure } from "./_core/trpc";
import { findExactFinancialCandidate } from "./vtigerFinancialCandidateService";
import { previewManualForHireHandover, enrollManualForHireHandover } from "./financialForHireManualHandoverService";
import { listManualForHireHandovers, isManualForHireHandoverEnabled } from "./financialForHireManualHandoverDb";

const accountsAdmin = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== "admin" || ctx.user.id <= 0 || ctx.user.status === "disabled") throw new TRPCError({ code: "FORBIDDEN", message: "An active Accounts administrator is required." });
  return next({ ctx });
});
const previewInput = z.object({
  exactContainerControl: z.string().trim().regex(/^(?:C\d{1,12}|\d+x\d{1,12})$/i),
  manualPoNumber: z.string().trim().regex(/^HC\d{1,12}(?:-[2-9]\d*|-1\d+)?$/i),
  coveredThrough: z.string().trim().min(8).max(10),
  effectiveFrom: z.string().trim().min(8).max(10),
  confirmedLatestCoverage: z.boolean(),
  confirmedNoOtherFutureCoverage: z.boolean(),
});
async function resolveControl(exactContainerControl: string) {
  if (/^\d+x\d+$/i.test(exactContainerControl)) return exactContainerControl.replace(/X/, "x");
  const lookup = await findExactFinancialCandidate({ sourceCategory: "container_control", businessNumber: exactContainerControl.toUpperCase() });
  if (lookup.outcome !== "found" || lookup.candidates.length !== 1) throw new TRPCError({ code: "PRECONDITION_FAILED", message: lookup.message });
  return lookup.candidates[0]!.recordId;
}
export const manualForHireHandoverRouter = router({
  readiness: accountsAdmin.query(() => ({ implementationReady: true as const, enrollmentEnabled: isManualForHireHandoverEnabled(), recurringActivationSeparate: true as const, accountsCoverageConfirmationRequired: true as const })),
  list: accountsAdmin.input(z.object({ limit: z.number().int().min(1).max(200).optional() }).optional()).query(async ({ input }) => {
    const rows = await listManualForHireHandovers(input?.limit ?? 100);
    return rows.map(row => ({ id: row.id, containerControlNumber: row.containerControlNumber, manualPoNumber: row.manualPoNumber, coveredThrough: row.coveredThrough, nextBillingDate: row.nextBillingDate, status: row.status, planHash: row.planHash, approvedAt: row.approvedAt, holdReason: row.holdReason }));
  }),
  preview: accountsAdmin.input(previewInput).mutation(async ({ input, ctx }) => {
    const recordId = await resolveControl(input.exactContainerControl);
    const { evidence: _evidence, ...result } = await previewManualForHireHandover({ ...input, recordId, manualPoNumber: input.manualPoNumber.toUpperCase(), reviewedBy: ctx.user.id, expectedControlNumber: /^C\d+$/i.test(input.exactContainerControl) ? input.exactContainerControl.toUpperCase() : undefined });
    if (result.plan && /^C\d+$/i.test(input.exactContainerControl) && result.plan.containerControlNumber !== input.exactContainerControl.toUpperCase()) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Current Container Control no longer matches the exact lookup." });
    return result;
  }),
  approve: accountsAdmin.input(previewInput.extend({
    confirmedLatestCoverage: z.literal(true),
    confirmedNoOtherFutureCoverage: z.literal(true),
    expectedPlanHash: z.string().regex(/^[a-f0-9]{64}$/),
    manualCreationStopped: z.literal(true),
    acknowledgement: z.literal("FUTURE_ONLY_MANUAL_PO_HANDOVER"),
  })).mutation(async ({ input, ctx }) => {
    if (!isManualForHireHandoverEnabled()) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Manual hire handover enrollment remains disabled. No record or financial document was created." });
    const recordId = await resolveControl(input.exactContainerControl);
    return enrollManualForHireHandover({ ...input, recordId, manualPoNumber: input.manualPoNumber.toUpperCase(), reviewedBy: ctx.user.id, approvedBy: ctx.user.id, expectedControlNumber: /^C\d+$/i.test(input.exactContainerControl) ? input.exactContainerControl.toUpperCase() : undefined });
  }),
});
