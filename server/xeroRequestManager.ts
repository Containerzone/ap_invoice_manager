import type { AxiosResponse } from "axios";
import {
  getXeroApiCache,
  getXeroToken,
  invalidateXeroApiCache,
  setXeroApiCache,
  updateXeroRateLimitState,
} from "./db";
import { reportWorkflowFailureSafely } from "./workflowAlertService";

export type XeroRequestAuth = { token: string; tenantId: string };

const MIN_REQUEST_INTERVAL_MS = 1_100;
const tenantTails = new Map<string, Promise<void>>();
const tenantLastRequestAt = new Map<string, number>();
const inFlightReads = new Map<string, Promise<unknown>>();

function headerValue(headers: unknown, name: string): string | null {
  const values = headers as Record<string, unknown> | undefined;
  const raw = values?.[name] ?? values?.[name.toLowerCase()];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value == null ? null : String(value);
}

function integerHeader(headers: unknown, name: string): number | null {
  const parsed = Number(headerValue(headers, name));
  return Number.isFinite(parsed) ? parsed : null;
}

function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.ceil(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.ceil((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

async function wait(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function assertTenantNotPaused(tenantId: string): Promise<void> {
  const token = await getXeroToken();
  if (!token || token.tenantId !== tenantId || !token.rateLimitPausedUntil) return;
  const remainingMs = token.rateLimitPausedUntil.getTime() - Date.now();
  if (remainingMs <= 0) {
    await updateXeroRateLimitState(tenantId, {
      rateLimitPausedUntil: null,
      rateLimitProblem: null,
      rateLimitRetryAfterSeconds: null,
      rateLimitUpdatedAt: new Date(),
    });
    return;
  }
  const problem = token.rateLimitProblem === "day" ? "daily" : token.rateLimitProblem === "minute" ? "minute" : "API";
  throw new Error(`Xero ${problem} request limit is still active. Xero says to retry in ${formatDuration(remainingMs / 1000)}.`);
}

async function recordHeaders(tenantId: string, headers: unknown): Promise<void> {
  const minuteRemaining = integerHeader(headers, "x-minlimit-remaining");
  const dayRemaining = integerHeader(headers, "x-daylimit-remaining");
  if (minuteRemaining === null && dayRemaining === null) return;
  await updateXeroRateLimitState(tenantId, {
    rateLimitMinuteRemaining: minuteRemaining,
    rateLimitDayRemaining: dayRemaining,
    rateLimitUpdatedAt: new Date(),
  });
}

async function recordRateLimit(tenantId: string, headers: unknown): Promise<never> {
  const problem = headerValue(headers, "x-rate-limit-problem") ?? "unknown";
  const retryAfterSeconds = Math.max(1, integerHeader(headers, "retry-after") ?? 60);
  const minuteRemaining = integerHeader(headers, "x-minlimit-remaining");
  const dayRemaining = integerHeader(headers, "x-daylimit-remaining");
  const pausedUntil = new Date(Date.now() + retryAfterSeconds * 1000);
  await updateXeroRateLimitState(tenantId, {
    rateLimitPausedUntil: pausedUntil,
    rateLimitProblem: problem,
    rateLimitRetryAfterSeconds: retryAfterSeconds,
    rateLimitMinuteRemaining: minuteRemaining,
    rateLimitDayRemaining: dayRemaining,
    rateLimitUpdatedAt: new Date(),
  });
  const label = problem === "day" ? "daily" : problem === "minute" ? "minute" : "API";
  throw new Error(`Xero ${label} request limit has been reached. Xero says to retry in ${formatDuration(retryAfterSeconds)}.`);
}

/**
 * Runs every Xero Accounting API call through one tenant queue. The 1.1 second
 * interval keeps this application below Xero's 60 calls/minute tenant limit.
 */
export async function runXeroRequest<T>(
  auth: XeroRequestAuth,
  operationName: string,
  operation: () => Promise<AxiosResponse<T>>,
): Promise<AxiosResponse<T>> {
  const previousTail = tenantTails.get(auth.tenantId) ?? Promise.resolve();
  let release!: () => void;
  const currentTail = new Promise<void>((resolve) => { release = resolve; });
  const queuedTail = previousTail.catch(() => undefined).then(() => currentTail);
  tenantTails.set(auth.tenantId, queuedTail);

  await previousTail.catch(() => undefined);
  try {
    await assertTenantNotPaused(auth.tenantId);
    const elapsed = Date.now() - (tenantLastRequestAt.get(auth.tenantId) ?? 0);
    await wait(MIN_REQUEST_INTERVAL_MS - elapsed);
    tenantLastRequestAt.set(auth.tenantId, Date.now());
    try {
      const response = await operation();
      await recordHeaders(auth.tenantId, response.headers);
      return response;
    } catch (error: any) {
      if (error?.response?.status === 429) {
        try {
          return await recordRateLimit(auth.tenantId, error.response.headers);
        } catch (rateLimitError: any) {
          reportWorkflowFailureSafely({
            workflowType: "xero-api",
            recordKey: `xero:${auth.tenantId}:${operationName}`,
            title: `Xero request limit reached: ${operationName}`,
            errorMessage: rateLimitError?.message ?? "Xero request limit reached",
            details: { operation: operationName, httpStatus: 429 },
            severity: "warning",
          });
          throw rateLimitError;
        }
      }
      reportWorkflowFailureSafely({
        workflowType: "xero-api",
        recordKey: `xero:${auth.tenantId}:${operationName}`,
        title: `Xero request failed: ${operationName}`,
        errorMessage: error?.message ?? "Xero API request failed",
        details: { operation: operationName, httpStatus: error?.response?.status },
        severity: "error",
      });
      throw error;
    }
  } finally {
    release();
    if (tenantTails.get(auth.tenantId) === queuedTail) tenantTails.delete(auth.tenantId);
  }
}

export async function runCachedXeroGet<T>(
  auth: XeroRequestAuth,
  cacheKey: string,
  ttlMs: number,
  operation: () => Promise<AxiosResponse<T>>,
): Promise<T> {
  const cached = await getXeroApiCache<T>(auth.tenantId, cacheKey);
  if (cached !== null) return cached;

  const inFlightKey = `${auth.tenantId}:${cacheKey}`;
  const existing = inFlightReads.get(inFlightKey) as Promise<T> | undefined;
  if (existing) return existing;

  const pending = (async () => {
    const response = await runXeroRequest(auth, `GET ${cacheKey}`, operation);
    await setXeroApiCache(auth.tenantId, cacheKey, response.data, ttlMs);
    return response.data;
  })();
  inFlightReads.set(inFlightKey, pending);
  try {
    return await pending;
  } finally {
    inFlightReads.delete(inFlightKey);
  }
}

export async function invalidateXeroCache(auth: XeroRequestAuth, cacheKeyPrefix?: string): Promise<void> {
  await invalidateXeroApiCache(auth.tenantId, cacheKeyPrefix);
}

export const XERO_CACHE_TTL = {
  purchaseOrder: 60 * 60 * 1000,
  supplierSearch: 6 * 60 * 60 * 1000,
  invoiceSearch: 30 * 60 * 1000,
  paymentStatus: 15 * 60 * 1000,
} as const;
