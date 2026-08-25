export type ResolveConfirmationState = {
  hasXeroConflict: boolean;
  xeroConflictAcknowledged: boolean;
  supplierContactNeedsSelection: boolean;
  selectedXeroContactId: string;
  contactSelectionApproved: boolean;
};

export function getResolveConfirmationBlockers(state: ResolveConfirmationState): string[] {
  return [
    ...(state.hasXeroConflict && !state.xeroConflictAcknowledged
      ? ["acknowledge the invoice-number conflict"]
      : []),
    ...(state.supplierContactNeedsSelection && !state.selectedXeroContactId
      ? ["select the Xero supplier contact"]
      : []),
    ...(state.supplierContactNeedsSelection && state.selectedXeroContactId && !state.contactSelectionApproved
      ? ["confirm the selected Xero supplier contact"]
      : []),
  ];
}
