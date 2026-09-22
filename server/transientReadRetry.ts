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
