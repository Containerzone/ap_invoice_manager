import {
  evaluateFinancialWorkflow,
  type FinancialWorkflowInput,
  type FinancialWorkflowEvaluation,
} from "./financialWorkflowEngine";
import {
  persistFinancialWorkflowEvaluation,
  type PersistedFinancialEvaluation,
} from "./financialWorkflowDb";

/**
 * Single entry point for all first-phase financial triggers. This application
 * is intentionally locked to shadow mode. Do not add Xero POST/PUT/PATCH calls
 * here: future live cutover must be document-specific and separately approved.
 */
export const FINANCIAL_SHADOW_MODE = true as const;

export type ShadowEvaluationResult = {
  evaluation: FinancialWorkflowEvaluation;
  persistence: PersistedFinancialEvaluation;
};

export async function evaluateAndPersistFinancialWorkflow(
  input: FinancialWorkflowInput,
  createdBy?: number,
): Promise<ShadowEvaluationResult> {
  if (!FINANCIAL_SHADOW_MODE) {
    throw new Error("Financial workflow execution is restricted to shadow mode");
  }
  const evaluation = evaluateFinancialWorkflow({ ...input });
  const persistence = await persistFinancialWorkflowEvaluation(input, evaluation, createdBy);
  return { evaluation, persistence };
}
