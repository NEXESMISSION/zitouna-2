/**
 * Data-driven RPC probes for staging / disposable Supabase projects.
 * Extend this list as you add RPCs — keep ids stable for CI logs.
 *
 * expect:
 *   - "deny"  → must not return a successful “authenticated” result for this role
 *   - "allow" → must succeed (no error) — use sparingly; often needs real IDs
 *   - "skip"  → not run (placeholder)
 *
 * denyStyle (when expect === "deny"):
 *   - (default)     → Supabase client `error` must be set (PostgREST / Postgres error)
 *   - "json_ok_false" → pass if `error` OR `data.ok === false` (RPC returns 200 + envelope)
 *   - "empty_array"   → pass if `error` OR `Array.isArray(data) && data.length === 0`
 *   - "parrainage_anomaly_safe" → pass if `error` OR anon sees only empty anomaly arrays (no leaked rows)
 */

export const PROBE_MATRIX = [
  /* Anonymous session — sensitive business RPCs should not succeed */
  { id: 'anon_increment_wallet', rpc: 'increment_ambassador_wallet_balance', args: { p_client_id: '00000000-0000-0000-0000-000000000001', p_delta: 0.01 }, role: 'anon', expect: 'deny' },
  { id: 'anon_referral_summary', rpc: 'get_my_referral_summary', args: {}, role: 'anon', expect: 'deny', denyStyle: 'json_ok_false' },
  { id: 'anon_request_payout', rpc: 'request_ambassador_payout', args: { p_amount: 1, p_idempotency_key: 'probe-anon' }, role: 'anon', expect: 'deny' },
  { id: 'anon_ensure_profile', rpc: 'ensure_current_client_profile', args: {}, role: 'anon', expect: 'deny', denyStyle: 'json_ok_false' },
  { id: 'anon_heal_profile', rpc: 'heal_my_client_profile_now', args: {}, role: 'anon', expect: 'deny', denyStyle: 'json_ok_false' },
  { id: 'anon_list_seller_assign', rpc: 'list_seller_assignments', args: { p_client_id: null }, role: 'anon', expect: 'deny', denyStyle: 'empty_array' },
  { id: 'anon_my_seller_assign', rpc: 'list_my_seller_assignments', args: {}, role: 'anon', expect: 'deny', denyStyle: 'empty_array' },
  { id: 'anon_assign_seller', rpc: 'assign_seller_parcel', args: { p_client_id: '00000000-0000-0000-0000-000000000001', p_project_id: 'proj-test', p_parcel_id: '00000000-0000-0000-0000-000000000002', p_note: '' }, role: 'anon', expect: 'deny' },
  { id: 'anon_revoke_seller', rpc: 'revoke_seller_parcel', args: { p_assignment_id: null, p_client_id: null, p_parcel_id: null, p_reason: 'probe' }, role: 'anon', expect: 'deny' },
  { id: 'anon_expire_reservations', rpc: 'expire_pending_sales_reservations', args: { p_limit: 1 }, role: 'anon', expect: 'deny' },
  { id: 'anon_lookup_client', rpc: 'lookup_client_for_sale', args: { p_query: 'probe' }, role: 'anon', expect: 'deny' },
  {
    id: 'anon_create_buyer_stub',
    rpc: 'create_buyer_stub_for_sale',
    args: {
      p_code: 'PROBE',
      p_name: 'Probe',
      p_email: 'probe@example.invalid',
      p_phone: '+21600000001',
      p_cin: '00000000',
      p_city: 'Tunis',
    },
    role: 'anon',
    expect: 'deny',
  },
  { id: 'anon_portfolio_cin', rpc: 'get_portfolio_preview_for_cin', args: { p_cin: '00000000' }, role: 'anon', expect: 'deny' },
  { id: 'anon_portfolio_phone', rpc: 'get_portfolio_preview_for_phone', args: { p_phone: '+21600000000' }, role: 'anon', expect: 'deny' },
  { id: 'anon_request_otp', rpc: 'request_phone_access_otp', args: { p_phone: '12345678', p_email: '', p_name: '' }, role: 'anon', expect: 'deny' },
  { id: 'anon_verify_otp', rpc: 'verify_phone_access_otp', args: { p_request_id: '00000000-0000-0000-0000-000000000001', p_code: '000000' }, role: 'anon', expect: 'deny' },
  { id: 'anon_approve_access', rpc: 'approve_data_access_and_link_client', args: { p_request_id: '00000000-0000-0000-0000-000000000001' }, role: 'anon', expect: 'deny' },
  { id: 'anon_admin_approve_phone', rpc: 'admin_approve_phone_request_and_link', args: { p_request_id: '00000000-0000-0000-0000-000000000001' }, role: 'anon', expect: 'deny' },
  { id: 'anon_upsert_data_access', rpc: 'upsert_data_access_request', args: { p_cin: '00000000', p_email: 'a@b.c', p_name: 'Probe' }, role: 'anon', expect: 'deny' },
  { id: 'anon_mark_notif_read', rpc: 'mark_notifications_read', args: { p_ids: [] }, role: 'anon', expect: 'deny' },
  { id: 'anon_mark_all_notif', rpc: 'mark_all_notifications_read', args: {}, role: 'anon', expect: 'deny' },
  { id: 'anon_archive_notif', rpc: 'archive_notification', args: { p_id: '00000000-0000-0000-0000-000000000001' }, role: 'anon', expect: 'deny' },
  {
    id: 'anon_append_audit',
    rpc: 'append_client_audit',
    args: {
      p_action: 'probe',
      p_entity: 'session',
      p_entity_id: '',
      p_details: '',
      p_metadata: {},
      p_severity: 'info',
      p_category: 'auth',
    },
    role: 'anon',
    expect: 'deny',
  },
  { id: 'anon_detect_anomalies', rpc: 'detect_parrainage_anomalies', args: {}, role: 'anon', expect: 'deny', denyStyle: 'parrainage_anomaly_safe' },

  /**
   * Authenticated user A — cross-tenant checks (need PROBE_JWT_USER_A + PROBE_FOREIGN_CLIENT_ID).
   * If env vars are missing, these rows are skipped at runtime.
   */
  {
    id: 'user_a_wallet_other_client',
    rpc: 'increment_ambassador_wallet_balance',
    args: { p_client_id: '__FOREIGN_CLIENT_ID__', p_delta: 0.01 },
    role: 'user_a',
    expect: 'deny',
    needsEnv: ['PROBE_JWT_USER_A', 'PROBE_FOREIGN_CLIENT_ID'],
  },
  {
    id: 'user_a_list_seller_other',
    rpc: 'list_seller_assignments',
    args: { p_client_id: '__FOREIGN_CLIENT_ID__' },
    role: 'user_a',
    expect: 'deny',
    denyStyle: 'empty_array',
    needsEnv: ['PROBE_JWT_USER_A', 'PROBE_FOREIGN_CLIENT_ID'],
  },
]
