# Workflow QA Matrix

This matrix validates the end-to-end operational flow:

`Ventes -> Coordination -> Service juridique -> Finance -> Notaire -> Service de recouvrement`

## Preconditions

- SQL applied in this order:
  1. `database/schema.sql`
  2. `database/migrations/001_workflow_alignment.sql`
  3. `database/seed.sql` (optional)
  4. `database/logic.sql`
  5. `database/policies.sql`
- Test users available for roles: Sales, Finance, Legal/Juridique, Notaire.

## Scenario Matrix

| ID | Scenario | Steps | Expected Result |
|---|---|---|---|
| W01 | Sale creation baseline | Create sale from `SellPage` with valid client/project/parcel | Sale status becomes `pending_finance`; parcel is reserved |
| W02 | Coordination visibility continuity | Open `CoordinationPage` after W01 | Dossier appears in Encaissement follow-up |
| W03 | Finance confirmation transition | Confirm client collection in `FinanceDashboardPage` | RPC `finance_confirm_sale` transitions sale to `pending_legal`; `finance_confirmed_at` set |
| W04 | Coordination post-finance continuity | Return to `CoordinationPage` | Same dossier remains visible with badge `Bureau notarial` |
| W05 | Juridique appointment linkage | Planify legal-service appointment in Coordination | Appointment stored with `sale_id` (or legacy note tag fallback) and appears in juridique calendar |
| W06 | Notary queue gating | Open `NotaryDashboardPage` | Only `pending_legal` dossiers appear |
| W07 | Notary finalization (full payment) | Finalize a full-payment sale in Notary | Sale is stamped and ends `completed`; legal RPC side effects executed |
| W08 | Notary finalization (installments) | Finalize installment sale in Notary | Sale becomes `active`; installment plan created |
| W09 | Recouvrement activation | Open `PaymentPlansPage` after W08 | New installment plan appears in `En recouvrement` |
| W10 | Installment approval lifecycle | Approve one installment receipt | Payment status becomes `approved`; passive commission logic runs |
| W11 | Plan completion closure | Approve all installments for one plan | Plan status becomes `completed`; sale transitions `completed` |
| W12 | Archive behavior | Cancel a sale linked to plan | Plan appears in `Archives` scope |

## Data Integrity Checks

Run these checks from the UI cards (Coordination / Finance / Notary integrity indicators) and optionally SQL:

- `orphanAppointments = 0`
- `invalidStatusJumps = 0`
- `financeConfirmedWithoutLegalMilestone = 0` (except intentionally created test cases)

## Regression Checklist

- Role guards unchanged: Sales cannot execute legal-only actions; Finance/Legal/Notary pages remain separated.
- Legacy data remains readable:
  - old appointments with `[sale:<id>]` still resolve,
  - legacy sale statuses `pending` / `signed` render through alias mapping.
- No console/API errors for missing schema fields (`seller_*`, `legal_*`, `appointments.sale_id`).
