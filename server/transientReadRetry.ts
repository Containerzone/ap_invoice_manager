/**
 * Retries a read operation once after a short delay. It is deliberately not
 * used for writes or external side effects, so it cannot duplicate a workflow
 * action if the first attempt's outcome is uncertain.
 */
export async function retryReadOnce<T>(
  read: () => Promise<T>,
  retryDelayMs = 250,
): Promise<T> {
  try {
    return await read();
  } catch (firstError) {
    if (retryDelayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs));
    }
    try {
      return await read();
    } catch {
      throw firstError;
    }
  }
}

/**
 * Retries a read once only when the caller has identified the failure as
 * transient. The second result/error is returned directly so callers never
 * mistake a failed retry for success. It is not suitable for writes.
 */
export async function retryReadOnceWhen<T>(
  read: () => Promise<T>,
  shouldRetry: (error: unknown) => boolean,
  retryDelayMs = 250,
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (!shouldRetry(error)) throw error;
    if (retryDelayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs));
    }
    return read();
  }
}
