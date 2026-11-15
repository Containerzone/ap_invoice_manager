import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./financialWorkflowDb", () => ({ getFinancialWorkflowConfig: vi.fn(), upsertFinancialWorkflowConfig: vi.fn() }));
import { FOR_HIRE_RELEASE_KEY, FOR_HIRE_RULES_HASH, FOR_HIRE_RECURRING_RULES_HASH, assertForHireRelease, assertForHireRecurringControlAllowed, approveForHireReleasePolicy, approveRecurringForHireRelease, getForHireReleasePolicy, prepareForHireReleasePolicy, resolveForHireRelease, type ForHireReleasePolicy } from "./financialForHireRelease";
import * as workflowDb from "./financialWorkflowDb";
const control = "79x489745";
function released(overrides: Partial<ForHireReleasePolicy> = {}): ForHireReleasePolicy {
  return {
    releaseKey: "FOR-HIRE-UNIT-TEST", rulesHash: FOR_HIRE_RULES_HASH, enabled: true,
    initialEnabled: true, recurringEnabled: true, approvedBy: 9,
    approvedAt: "2026-10-01T00:00:00.000Z", effectiveFrom: "2026-10-02T00:00:00.000Z",
    forHireOnlyVtigerBranch: true, initialOperationsHandoff: true, recurringOperationsHandoff: true,
    migrationScope: "new_events_only", recurringRulesHash: FOR_HIRE_RECURRING_RULES_HASH,
    recurringControlIds: [control], recurringApprovedAt: "2026-11-15T10:00:00.000Z", recurringEffectiveFrom: "2026-11-15T10:00:00.000Z", ...overrides,
  };
}
beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-15T11:00:00.000Z"));
  vi.stubEnv("FINANCIAL_FOR_HIRE_AUTOMATIC_ENABLED", "false");
  vi.mocked(workflowDb.getFinancialWorkflowConfig).mockResolvedValue([] as any);
  vi.mocked(workflowDb.upsertFinancialWorkflowConfig).mockResolvedValue(undefined);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
describe("For Hire scoped standing release", () => {
  it("defaults off, with no recurring scope or handover", () => {
    expect(resolveForHireRelease(null)).toMatchObject({ releaseKey: "", rulesHash: FOR_HIRE_RULES_HASH, enabled: false, approvedBy: null, initialEnabled: false, recurringEnabled: false, recurringOperationsHandoff: false, recurringRulesHash: null, recurringControlIds: [], recurringApprovedAt: null, recurringEffectiveFrom: null });
    expect(() => assertForHireRelease(resolveForHireRelease(null), "initial")).toThrow(/disabled/i);
  });
  it("does not mistake unrelated configuration for release", async () => {
    vi.mocked(workflowDb.getFinancialWorkflowConfig).mockResolvedValue([{configKey:"other",configValue:released()}] as any);
    await expect(getForHireReleasePolicy()).resolves.toMatchObject({enabled:false});
  });
  it.each([
    ["missing independent branch",{forHireOnlyVtigerBranch:false},"FOR HIRE-only"],
    ["missing initial handover",{initialOperationsHandoff:false},"initial Operations"],
    ["missing recurring handover",{recurringOperationsHandoff:false},"recurring schedule"],
  ] as const)("rejects %s",(_name,patch,message)=>{
    vi.stubEnv("FINANCIAL_FOR_HIRE_AUTOMATIC_ENABLED","true");
    expect(()=>assertForHireRelease(released(patch),"recurring")).toThrow(message);
  });
  it("keeps preparation disabled and local",async()=>{
    const p=await prepareForHireReleasePolicy(9);
    expect(p).toMatchObject({enabled:false,approvedBy:null,recurringControlIds:[]});
    expect(workflowDb.upsertFinancialWorkflowConfig).toHaveBeenCalledWith(FOR_HIRE_RELEASE_KEY,p,expect.stringMatching(/disabled/i),9);
  });
  it("initial approval alone never grants unscoped recurring authority",async()=>{
    const p=await approveForHireReleasePolicy({approvedBy:9,effectiveFrom:"2026-10-02T00:00:00.000Z",forHireOnlyVtigerBranch:true,initialOperationsHandoff:true,recurringOperationsHandoff:true});
    vi.stubEnv("FINANCIAL_FOR_HIRE_AUTOMATIC_ENABLED","true");
    expect(p).toMatchObject({initialEnabled:true,recurringRulesHash:null,recurringControlIds:[]});
    expect(()=>assertForHireRelease(p,"initial")).not.toThrow();
    expect(()=>assertForHireRelease(p,"recurring")).toThrow(/scoped release/i);
  });
  it("initial-only release remains usable without new recurring fields",()=>{
    vi.stubEnv("FINANCIAL_FOR_HIRE_AUTOMATIC_ENABLED","true");
    const p=resolveForHireRelease({...released(),recurringRulesHash:undefined,recurringControlIds:undefined,recurringEnabled:false,recurringOperationsHandoff:false});
    expect(()=>assertForHireRelease(p,"initial")).not.toThrow();
    expect(()=>assertForHireRelease(p,"recurring")).toThrow(/recurring/i);
  });
  it.each([
    {recurringRulesHash:null},{recurringRulesHash:"old-hash"},{recurringControlIds:[]},{recurringControlIds:["C1920"]},
    {recurringApprovedAt:null},{recurringApprovedAt:"invalid"},{recurringApprovedAt:"2026-12-01T00:00:00Z"},
    {recurringEffectiveFrom:null},{recurringEffectiveFrom:"invalid"},{recurringEffectiveFrom:"2026-12-01T00:00:00Z"},
  ])("rejects incomplete/stale/future recurring authority %j",patch=>{
    vi.stubEnv("FINANCIAL_FOR_HIRE_AUTOMATIC_ENABLED","true");
    expect(()=>assertForHireRelease(released(patch as any),"recurring")).toThrow(/scoped release/i);
  });
  it("allows only the exact approved control at direct/transport boundary",()=>{
    vi.stubEnv("FINANCIAL_FOR_HIRE_AUTOMATIC_ENABLED","true");
    expect(()=>assertForHireRecurringControlAllowed(released(),control)).not.toThrow();
    for(const id of ["79x489678","C1920","79x489745 ","79X489745"])
      expect(()=>assertForHireRecurringControlAllowed(released(),id)).toThrow(/outside/i);
  });
  it.each([[],["C1920"],[control,"C1918"],[control,null],["79X489745"],[control,"*"]])("scope fails closed rather than filters malformed values %j",ids=>{
    expect(resolveForHireRelease({...released(),recurringControlIds:ids as any}).recurringControlIds).toEqual([]);
  });
  it("normalizes duplicate valid IDs, never a wildcard",()=>{
    expect(resolveForHireRelease({...released(),recurringControlIds:[control,control,"79x1"]}).recurringControlIds).toEqual(["79x1",control]);
  });
  it("scoped approval preserves initial policy identity, approval and effective time",async()=>{
    vi.stubEnv("FINANCIAL_FOR_HIRE_AUTOMATIC_ENABLED","true");
    const old=released({recurringEnabled:false,recurringOperationsHandoff:false,recurringRulesHash:null,recurringControlIds:[],recurringApprovedAt:null,recurringEffectiveFrom:null});
    vi.mocked(workflowDb.getFinancialWorkflowConfig).mockResolvedValue([{configKey:FOR_HIRE_RELEASE_KEY,configValue:old}] as any);
    const p=await approveRecurringForHireRelease({approvedBy:9,effectiveFrom:"2026-11-15T11:00:00.000Z",approvedControlIds:[control],recurringOperationsHandoff:true});
    expect(p).toMatchObject({recurringEnabled:true,recurringControlIds:[control],recurringRulesHash:FOR_HIRE_RECURRING_RULES_HASH,approvedBy:old.approvedBy,approvedAt:old.approvedAt,effectiveFrom:old.effectiveFrom,rulesHash:old.rulesHash,releaseKey:old.releaseKey,initialEnabled:true});
    expect(workflowDb.upsertFinancialWorkflowConfig).toHaveBeenCalledTimes(1);
    expect(()=>assertForHireRecurringControlAllowed(p,control)).not.toThrow();
  });
  it.each([{approvedBy:8},{approvedControlIds:[]},{approvedControlIds:["C1920"]},{effectiveFrom:"invalid"},{recurringOperationsHandoff:false}])("invalid scoped approval makes no configuration write %j",async patch=>{
    vi.stubEnv("FINANCIAL_FOR_HIRE_AUTOMATIC_ENABLED","true");
    vi.mocked(workflowDb.getFinancialWorkflowConfig).mockResolvedValue([{configKey:FOR_HIRE_RELEASE_KEY,configValue:released({recurringEnabled:false})}] as any);
    await expect(approveRecurringForHireRelease({approvedBy:9,effectiveFrom:"2026-11-15T11:00:00.000Z",approvedControlIds:[control],recurringOperationsHandoff:true,...patch} as any)).rejects.toThrow(/approval requires/i);
    expect(workflowDb.upsertFinancialWorkflowConfig).not.toHaveBeenCalled();
  });
});
