/**
 * Data-driven table probes against PostgREST for staging / disposable
 * Supabase projects.
 *
 * Fills the gap the RPC matrix misses: direct CRUD via the REST API.
 * The DEV_SECURITY_AUDIT finding C1 (installment_payments.amount tamper)
 * was exactly this class of bug — no RPC probe could have caught it.
 *
 * Row shape:
 *   id          stable probe label (CI logs)
 *   table       public table / view name (e.g. "installment_payments")
 *   op          "select" | "insert" | "update" | "delete"
 *   role        "anon" | "user_a" | "user_b"
 *   payload     object for insert/update
 *   where       { col: val } eq filter applied for select/update/delete
 *   limit       optional max rows to request (SELECT)
 *   expect      "deny"   → must error OR return empty for select
 *               "allow"  → must succeed (used sparingly)
 *               "allow_limited" → must succeed; assert row cap (SELECT only)
 *   denyStyle   "strict"       → non-null PostgREST error
 *               "empty_result" → error OR empty rows (for SELECT on RLS-scoped tables)
 *   maxRows     for allow_limited — fail if returned rows > this
 *   needsEnv    env var names required to run
 *   description plain-english what this checks
 *
 * Env hooks (read from process.env):
 *   PROBE_FOREIGN_CLIENT_ID   another client's UUID
 *   PROBE_OWN_PAYMENT_ID      an installment_payments.id owned by user_a
 *   PROBE_OWN_PLAN_ID         an installment_plans.id owned by user_a
 */

export const TABLE_PROBE_MATRIX = [
  /* ---------------------------------------------------------------------
   * Anonymous — public catalog should be readable; everything else denied.
   * ------------------------------------------------------------------- */
  {
    id: 'anon_select_public_projects',
    table: 'projects',
    op: 'select',
    role: 'anon',
    limit: 1,
    expect: 'allow',
    description: 'anon can read public projects table (catalog)',
  },
  {
    id: 'anon_select_clients_denied',
    table: 'clients',
    op: 'select',
    role: 'anon',
    limit: 1,
    expect: 'deny',
    denyStyle: 'empty_result',
    description: 'anon must not read clients rows',
  },
  {
    id: 'anon_select_sales_denied',
    table: 'sales',
    op: 'select',
    role: 'anon',
    limit: 1,
    expect: 'deny',
    denyStyle: 'empty_result',
    description: 'anon must not read sales',
  },
  {
    id: 'anon_select_installment_plans_denied',
    table: 'installment_plans',
    op: 'select',
    role: 'anon',
    limit: 1,
    expect: 'deny',
    denyStyle: 'empty_result',
  },
  {
    id: 'anon_select_installment_payments_denied',
    table: 'installment_payments',
    op: 'select',
    role: 'anon',
    limit: 1,
    expect: 'deny',
    denyStyle: 'empty_result',
  },
  {
    id: 'anon_select_commission_events_denied',
    table: 'commission_events',
    op: 'select',
    role: 'anon',
    limit: 1,
    expect: 'deny',
    denyStyle: 'empty_result',
  },
  {
    id: 'anon_select_commission_payout_requests_denied',
    table: 'commission_payout_requests',
    op: 'select',
    role: 'anon',
    limit: 1,
    expect: 'deny',
    denyStyle: 'empty_result',
  },
  {
    id: 'anon_select_ambassador_wallets_denied',
    table: 'ambassador_wallets',
    op: 'select',
    role: 'anon',
    limit: 1,
    expect: 'deny',
    denyStyle: 'empty_result',
  },
  {
    id: 'anon_select_audit_logs_denied',
    table: 'audit_logs',
    op: 'select',
    role: 'anon',
    limit: 1,
    expect: 'deny',
    denyStyle: 'empty_result',
  },
  {
    id: 'anon_select_admin_users_denied',
    table: 'admin_users',
    op: 'select',
    role: 'anon',
    limit: 1,
    expect: 'deny',
    denyStyle: 'empty_result',
  },
  {
    id: 'anon_select_page_access_grants_denied',
    table: 'page_access_grants',
    op: 'select',
    role: 'anon',
    limit: 1,
    expect: 'deny',
    denyStyle: 'empty_result',
  },

  /* ---------------------------------------------------------------------
   * Anonymous writes — should all fail hard.
   * ------------------------------------------------------------------- */
  {
    id: 'anon_insert_sales_denied',
    table: 'sales',
    op: 'insert',
    role: 'anon',
    payload: {
      code: 'PROBE',
      project_id: '00000000-0000-0000-0000-000000000000',
      client_id: '00000000-0000-0000-0000-000000000000',
      status: 'pending',
    },
    expect: 'deny',
  },
  {
    id: 'anon_insert_clients_denied',
    table: 'clients',
    op: 'insert',
    role: 'anon',
    payload: { name: 'Probe', email: 'probe@example.invalid' },
    expect: 'deny',
  },
  {
    id: 'anon_insert_audit_logs_denied',
    table: 'audit_logs',
    op: 'insert',
    role: 'anon',
    payload: { action: 'probe', entity: 'probe' },
    expect: 'deny',
  },
  {
    id: 'anon_update_projects_denied',
    table: 'projects',
    op: 'update',
    role: 'anon',
    where: { id: '00000000-0000-0000-0000-000000000000' },
    payload: { title: 'hacked' },
    expect: 'deny',
    denyStyle: 'empty_result',
    description: 'anon UPDATE on projects must not affect rows',
  },
  {
    id: 'anon_update_installment_payments_denied',
    table: 'installment_payments',
    op: 'update',
    role: 'anon',
    where: { id: '00000000-0000-0000-0000-000000000000' },
    payload: { amount: 1 },
    expect: 'deny',
    denyStyle: 'empty_result',
  },

  /* ---------------------------------------------------------------------
   * User A — can only see their own scoped rows.
   * Requires PROBE_JWT_USER_A.
   * ------------------------------------------------------------------- */
  {
    id: 'user_a_select_own_clients_limited',
    table: 'clients',
    op: 'select',
    role: 'user_a',
    limit: 100,
    expect: 'allow_limited',
    maxRows: 1, // at most their own profile row
    needsEnv: ['PROBE_JWT_USER_A'],
    description: 'user_a sees at most their own client row',
  },
  {
    id: 'user_a_select_admin_users_denied',
    table: 'admin_users',
    op: 'select',
    role: 'user_a',
    limit: 1,
    expect: 'deny',
    denyStyle: 'empty_result',
    needsEnv: ['PROBE_JWT_USER_A'],
    description: 'non-staff user_a cannot read admin_users',
  },
  {
    id: 'user_a_select_audit_logs_denied',
    table: 'audit_logs',
    op: 'select',
    role: 'user_a',
    limit: 1,
    expect: 'deny',
    denyStyle: 'empty_result',
    needsEnv: ['PROBE_JWT_USER_A'],
  },
  {
    id: 'user_a_update_foreign_client_denied',
    table: 'clients',
    op: 'update',
    role: 'user_a',
    where: { id: '__FOREIGN_CLIENT_ID__' },
    payload: { name: 'hacked' },
    expect: 'deny',
    denyStyle: 'empty_result',
    needsEnv: ['PROBE_JWT_USER_A', 'PROBE_FOREIGN_CLIENT_ID'],
    description: 'IDOR: user_a cannot update another client row',
  },

  /* ---------------------------------------------------------------------
   * C1 + H2 regression probes — verify the DEV_SECURITY_AUDIT fixes.
   * Requires PROBE_JWT_USER_A + PROBE_OWN_PAYMENT_ID (a real payment
   * on a plan belonging to user_a, in status=pending, after migration).
   *
   * After security_remediation_2026_04_21.sql is applied, ALL of these
   * must fail; before the migration, C1 and H2 will succeed, which is
   * the signal that the DB hasn't been patched yet.
   * ------------------------------------------------------------------- */
  {
    id: 'c1_tamper_amount_denied',
    table: 'installment_payments',
    op: 'update',
    role: 'user_a',
    where: { id: '__OWN_PAYMENT_ID__' },
    payload: { amount: 1 },
    expect: 'deny',
    denyStyle: 'empty_result',
    needsEnv: ['PROBE_JWT_USER_A', 'PROBE_OWN_PAYMENT_ID'],
    description: 'C1: client cannot rewrite installment_payments.amount',
  },
  {
    id: 'c1_tamper_due_date_denied',
    table: 'installment_payments',
    op: 'update',
    role: 'user_a',
    where: { id: '__OWN_PAYMENT_ID__' },
    payload: { due_date: '2099-12-31' },
    expect: 'deny',
    denyStyle: 'empty_result',
    needsEnv: ['PROBE_JWT_USER_A', 'PROBE_OWN_PAYMENT_ID'],
    description: 'C1: client cannot move installment_payments.due_date',
  },
  {
    id: 'c1_tamper_approved_at_denied',
    table: 'installment_payments',
    op: 'update',
    role: 'user_a',
    where: { id: '__OWN_PAYMENT_ID__' },
    payload: { approved_at: '2026-01-01T00:00:00Z' },
    expect: 'deny',
    denyStyle: 'empty_result',
    needsEnv: ['PROBE_JWT_USER_A', 'PROBE_OWN_PAYMENT_ID'],
    description: 'C1: client cannot self-approve by setting approved_at',
  },
  {
    id: 'h2_self_reject_denied',
    table: 'installment_payments',
    op: 'update',
    role: 'user_a',
    where: { id: '__OWN_PAYMENT_ID__' },
    payload: { status: 'rejected' },
    expect: 'deny',
    denyStyle: 'empty_result',
    needsEnv: ['PROBE_JWT_USER_A', 'PROBE_OWN_PAYMENT_ID'],
    description: "H2: client cannot self-set status='rejected'",
  },
]
