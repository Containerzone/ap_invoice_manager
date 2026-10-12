# Operations-agent Deposit deduction reference

**Source reviewed:** authorised shared Operations-agent task `All in one Built till 08/08/26` (`z4BCTK6qpMx1xSv13ILqTy`), retrieved 12 October 2026. The reference is historical evidence only; no Operations-project code, settings, VTiger workflow, Make scenario or schedule was modified.

## Legacy rule evidenced

The Operations reference states that the Deposit workflow:

1. creates the Deposit invoice using item code `Deposit Required`, a quantity of one, and a Deposit amount inclusive of GST;
2. uses an inclusive Deposit Draft description in the form `Deposit for <Quote reference> from INV-<Deal>`; and
3. when the exact main invoice exists and is still `DRAFT`, retains every existing main-invoice line and appends one negative Deposit line.

The legacy deduction was described as the inclusive Deposit amount multiplied by `0.90909`, with the main-line description `Less deposit invoice INV-<Deal>-D`.

## AP implementation interpretation

The generic AP replacement must not copy legacy implementation mechanics blindly. It must instead use current VTiger/Xero reads and enforce:

- exact current Deal, Quote, customer, Deposit Draft, and main Draft IDs;
- main invoice must be exactly `ACCREC`, `DRAFT`, unallocated, and have the same immutable Xero Contact as the Deposit Draft;
- retain every existing main header and line, including Xero line IDs, then append at most one Deposit deduction;
- derive the deduction from the **read-back Xero Deposit Draft total**, not a webhook field;
- ensure the resulting GST-exclusive line plus GST equals the exact inclusive Deposit total using Xero's per-line GST calculation or its supported TaxAmount override;
- one idempotent local lifecycle record shared across retries, and exact Xero read-back before completion;
- no generic adoption, duplicate deduction, non-Draft amendment, approval/send/payment/delete, or VTiger mutation.

The D702933 incident used a different, user-approved description (`Deposit deduction — INV-702933-D`). A future generic implementation should use the legacy description above only after confirming that it is still the desired business wording.
