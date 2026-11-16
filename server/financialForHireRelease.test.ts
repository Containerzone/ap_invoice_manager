import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./financialWorkflowDb", () => ({ getFinancialWorkflowConfig: vi.fn(), upsertFinancialWorkflowConfig: vi.fn() }));
import { FOR_HIRE_RELEASE_KEY, FOR_HIRE_RULES_HASH, FOR_HIRE_RECURRING_RULES_HASH, FOR_HIRE_RECURRING_RULES_VERSION, assertForHireRelease, assertForHireRecurringControlAllowed, approveForHireReleasePolicy, approveRecurringForHireRelease, approveRecurringFutureForHireRelease, buildRecurringFutureForHireReleasePolicy, getForHireReleasePolicy, prepareForHireReleasePolicy, resolveForHireRelease, type ForHireReleasePolicy } from "./financialForHireRelease";
import * as workflowDb from "./financialWorkflowDb";
const control = "79x489745";
function released(overrides: Partial<ForHireReleasePolicy> = {}): ForHireReleasePolicy {
  return {
    releaseKey: "FOR-HIRE-UNIT-TEST", rulesHash: FOR_HIRE_RULES_HASH, enabled: true,
    initialEnabled: true, recurringEnabled: true, approvedBy: 9,
    approvedAt: "2026-10-01T00:00:00.000Z", effectiveFrom: "2026-10-02T00:00:00.000Z",
    forHireOnlyVtigerBranch: true, initialOperationsHandoff: true, recurringOperationsHandoff: true,
    migrationScope: "new_events_only", recurringRulesHash: FOR_HIRE_RECURRING_RULES_HASH,
    recurringFutureInitialsEnabled: false, recurringFutureInitialsFrom: null, recurringFutureExcludedControlIds: [],
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

describe("v4 future-initial recurring policy", () => {
  const exclusions = Array.from({ length: 17 }, (_, n) => `79x${500000 + n}`);
  const cutoff = "2026-11-15T10:30:00.000Z";
  const future = (patch: Partial<ForHireReleasePolicy> = {}) => released({ recurringControlIds: [],
    recurringFutureInitialsEnabled: true, recurringFutureInitialsFrom: cutoff, recurringFutureExcludedControlIds: exclusions,
    recurringEffectiveFrom: cutoff, ...patch });
  it("versions recurring authority independently without modifying the initial hash/key", () => {
    expect(FOR_HIRE_RECURRING_RULES_VERSION).toContain("v4");
    expect(FOR_HIRE_RULES_HASH).not.toBe(FOR_HIRE_RECURRING_RULES_HASH);
  });
  it("old policy inputs resolve future fields safely disabled", () => {
    expect(resolveForHireRelease({ ...released(), recurringFutureInitialsEnabled: undefined,
      recurringFutureInitialsFrom: undefined, recurringFutureExcludedControlIds: undefined })).toMatchObject({
        recurringFutureInitialsEnabled: false, recurringFutureInitialsFrom: null, recurringFutureExcludedControlIds: [] });
  });
  it("future-only authority has no named wildcard and still requires proof for each control", () => {
    vi.stubEnv("FINANCIAL_FOR_HIRE_AUTOMATIC_ENABLED", "true");
    expect(() => assertForHireRelease(future(), "recurring")).not.toThrow();
    expect(() => assertForHireRecurringControlAllowed(future(), control)).toThrow(/outside/);
    expect(() => assertForHireRecurringControlAllowed(future(), control, true as any)).toThrow(/outside/);
  });
  it.each([undefined, null, [], "*", ["C1920"], ["79x500000", null], ["79x500000 "], ["79x500000", "*"],
    Array.from({ length: 201 }, (_, n) => `79x${n + 1}`)])("malformed/unknown exclusion scope disables future authority rather than empty all-control scope %j", value => {
    vi.stubEnv("FINANCIAL_FOR_HIRE_AUTOMATIC_ENABLED", "true");
    const p = resolveForHireRelease({ ...future(), recurringFutureExcludedControlIds: value });
    expect(p.recurringFutureInitialsEnabled).toBe(false);
    expect(() => assertForHireRelease(p, "recurring")).toThrow(/scoped release/);
  });
  it.each([undefined, null, "invalid", "2026-11-31T10:30:00Z", "2026-11-15T10:30:00Z ", "2026-11-15", "2026-09-30T00:00:00Z", "2026-11-15T11:01:00Z", "2026-11-15T10:31:00Z"])("invalid cutoff cannot grant future scope %s", from => {
    vi.stubEnv("FINANCIAL_FOR_HIRE_AUTOMATIC_ENABLED", "true");
    expect(() => assertForHireRelease(future({ recurringFutureInitialsFrom: from as any }), "recurring")).toThrow(/scoped release/);
  });
  it("malformed future authority does not revoke separately valid exact named authority", () => {
    vi.stubEnv("FINANCIAL_FOR_HIRE_AUTOMATIC_ENABLED", "true");
    expect(() => assertForHireRecurringControlAllowed(future({ recurringControlIds: [control], recurringFutureExcludedControlIds: ["bad"] }), control)).not.toThrow();
    expect(() => assertForHireRecurringControlAllowed(released({ recurringControlIds: [control, "bad"] }), control)).toThrow(/scoped release/);
  });
  it("constructs explicit future approval purely and preserves initial authority and any reviewed exact controls", () => {
    vi.stubEnv("FINANCIAL_FOR_HIRE_AUTOMATIC_ENABLED", "true");
    const current = released({ recurringEnabled: false, recurringRulesHash: null });
    const p = buildRecurringFutureForHireReleasePolicy(current, { approvedBy: 9, effectiveFrom: cutoff, futureInitialsFrom: cutoff,
      excludedControlIds: exclusions, recurringOperationsHandoff: true });
    expect(p).toMatchObject({ releaseKey: current.releaseKey, rulesHash: current.rulesHash, approvedBy: current.approvedBy,
      approvedAt: current.approvedAt, effectiveFrom: current.effectiveFrom, initialEnabled: current.initialEnabled,
      recurringControlIds: current.recurringControlIds, recurringFutureInitialsEnabled: true, recurringFutureInitialsFrom: cutoff,
      recurringRulesHash: FOR_HIRE_RECURRING_RULES_HASH });
    expect(p.recurringFutureExcludedControlIds).toHaveLength(17);
    expect(workflowDb.upsertFinancialWorkflowConfig).not.toHaveBeenCalled();
    expect(() => assertForHireRelease(p, "recurring")).not.toThrow();
  });
  it("preserves the production initial Sydney-offset timestamp while enabling only a later UTC future cutover", () => {
    vi.stubEnv("FINANCIAL_FOR_HIRE_AUTOMATIC_ENABLED", "true");
    const current = released({ recurringEnabled: false, recurringRulesHash: null, effectiveFrom: "2026-10-11T20:20:52+11:00" });
    const p = buildRecurringFutureForHireReleasePolicy(current, { approvedBy: 9, effectiveFrom: cutoff, futureInitialsFrom: cutoff,
      excludedControlIds: exclusions, recurringOperationsHandoff: true });
    expect(p.effectiveFrom).toBe("2026-10-11T20:20:52+11:00");
    expect(p.releaseKey).toBe(current.releaseKey);
    expect(p.approvedAt).toBe(current.approvedAt);
    expect(() => assertForHireRelease(p, "recurring")).not.toThrow();
    expect(workflowDb.upsertFinancialWorkflowConfig).not.toHaveBeenCalled();
  });
  it("compares the preserved initial offset chronologically and never accepts an offset future cutoff", () => {
    vi.stubEnv("FINANCIAL_FOR_HIRE_AUTOMATIC_ENABLED", "true");
    const current = released({ recurringEnabled: false, recurringRulesHash: null, effectiveFrom: "2026-10-11T20:20:52+11:00" });
    const input = { approvedBy: 9, effectiveFrom: cutoff, futureInitialsFrom: "2026-10-11T09:20:51Z", excludedControlIds: exclusions, recurringOperationsHandoff: true as const };
    expect(() => buildRecurringFutureForHireReleasePolicy(current, input)).toThrow(/cutoff/);
    expect(() => buildRecurringFutureForHireReleasePolicy(current, { ...input, futureInitialsFrom: "2026-11-15T21:30:00+11:00" })).toThrow(/approval requires/);
    expect(workflowDb.upsertFinancialWorkflowConfig).not.toHaveBeenCalled();
  });
  it.each([{ approvedBy: 8 }, { excludedControlIds: [] }, { excludedControlIds: exclusions.slice(1) },
    { excludedControlIds: [...exclusions, "79x900"] }, { excludedControlIds: [...exclusions.slice(1), exclusions[1]] },
    { excludedControlIds: [...exclusions.slice(1), "C1911"] }, { excludedControlIds: [...exclusions.slice(1), "79x900 "] },
    { futureInitialsFrom: "invalid" }, { futureInitialsFrom: "2026-09-01T00:00:00Z" }, { futureInitialsFrom: "2026-11-15T10:31:00Z" },
    { effectiveFrom: "2026-11-15T11:01:00Z" }, { recurringOperationsHandoff: false }])("invalid future approval performs no configuration write %j", async patch => {
    vi.stubEnv("FINANCIAL_FOR_HIRE_AUTOMATIC_ENABLED", "true");
    vi.mocked(workflowDb.getFinancialWorkflowConfig).mockResolvedValue([{ configKey: FOR_HIRE_RELEASE_KEY, configValue: released() }] as any);
    await expect(approveRecurringFutureForHireRelease({ approvedBy: 9, effectiveFrom: cutoff, futureInitialsFrom: cutoff,
      excludedControlIds: exclusions, recurringOperationsHandoff: true, ...patch } as any)).rejects.toThrow(/approval requires/);
    expect(workflowDb.upsertFinancialWorkflowConfig).not.toHaveBeenCalled();
  });
  it("explicitly invoked valid future helper persists one approval without calling or creating a schedule", async () => {
    vi.stubEnv("FINANCIAL_FOR_HIRE_AUTOMATIC_ENABLED", "true");
    vi.mocked(workflowDb.getFinancialWorkflowConfig).mockResolvedValue([{ configKey: FOR_HIRE_RELEASE_KEY, configValue: released() }] as any);
    const p = await approveRecurringFutureForHireRelease({ approvedBy: 9, effectiveFrom: cutoff, futureInitialsFrom: cutoff,
      excludedControlIds: exclusions, recurringOperationsHandoff: true });
    expect(workflowDb.upsertFinancialWorkflowConfig).toHaveBeenCalledTimes(1);
    expect(workflowDb.upsertFinancialWorkflowConfig).toHaveBeenCalledWith(FOR_HIRE_RELEASE_KEY, p, expect.stringMatching(/17 old Accounts controls excluded/), 9);
  });
});
