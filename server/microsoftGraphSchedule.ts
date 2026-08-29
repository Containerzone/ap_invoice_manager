/** Picks an existing renewal schedule before creating another project-wide schedule. */
export function selectMicrosoftRenewalTaskUid(
  currentMailboxTaskUid?: string | null,
  priorMailboxTaskUid?: string | null,
): string | undefined {
  return currentMailboxTaskUid ?? priorMailboxTaskUid ?? undefined;
}
