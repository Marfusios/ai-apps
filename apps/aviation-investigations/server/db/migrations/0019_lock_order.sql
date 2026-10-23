-- Hand-written (Task 20, review fix round 2): retention takes the brief locks in the order
-- every other writer does.
--
-- Account deletion (delete_account_content(), migration 0018) and every change to a brief
-- (lock_brief() callers: a refinement's step, a cancel) lock a brief first and then touch its
-- steps; deletion goes on to the account's idempotency records and its anti-abuse record.
-- prune_controls() deleted idempotency and abuse records first, then the steps of expired
-- briefs, then the briefs: the reverse order, so a deletion of an account with an expired
-- brief could deadlock with the maintenance pass (40P01). Now it locks the expired briefs
-- in id order first, deletes their steps and the briefs, and only then the other records.
-- Same deletions and the same report as migration 0014's version; CREATE OR REPLACE keeps
-- the owner, SECURITY DEFINER (restated) and the EXECUTE grant.
CREATE OR REPLACE FUNCTION prune_controls() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  cutoff timestamptz := now() - interval '90 days';
  n_idempotency integer;
  n_buckets integer;
  n_trials integer;
  n_redemptions integer;
  n_abuse integer;
  n_ledger integer;
  n_leases integer;
  n_reservations integer;
  n_brief_steps integer;
  n_briefs integer;
BEGIN
  PERFORM set_config('aviation.pruning_controls', 'on', true);
  PERFORM 1 FROM briefs WHERE expires_at < now() ORDER BY id FOR UPDATE;
  DELETE FROM brief_steps s USING briefs b WHERE s.brief_id = b.id AND b.expires_at < now();
  GET DIAGNOSTICS n_brief_steps = ROW_COUNT;
  DELETE FROM briefs WHERE expires_at < now();
  GET DIAGNOSTICS n_briefs = ROW_COUNT;
  DELETE FROM idempotency WHERE expires_at < now();
  GET DIAGNOSTICS n_idempotency = ROW_COUNT;
  DELETE FROM usage_buckets WHERE expires_at < now();
  GET DIAGNOSTICS n_buckets = ROW_COUNT;
  DELETE FROM trial_identities WHERE expires_at < now();
  GET DIAGNOSTICS n_trials = ROW_COUNT;
  DELETE FROM turnstile_redemptions WHERE expires_at < now();
  GET DIAGNOSTICS n_redemptions = ROW_COUNT;
  DELETE FROM abuse_records WHERE retain_until < now();
  GET DIAGNOSTICS n_abuse = ROW_COUNT;
  DELETE FROM cost_ledger WHERE created_at < cutoff;
  GET DIAGNOSTICS n_ledger = ROW_COUNT;
  DELETE FROM leases l USING reservations r
    WHERE l.reservation_id = r.id AND r.status <> 'open' AND r.settled_at < cutoff
      AND NOT EXISTS (SELECT 1 FROM cost_ledger c WHERE c.reservation_id = r.id)
      AND NOT EXISTS (SELECT 1 FROM idempotency i WHERE i.reservation_id = r.id);
  GET DIAGNOSTICS n_leases = ROW_COUNT;
  DELETE FROM reservations r
    WHERE r.status <> 'open' AND r.settled_at < cutoff
      AND NOT EXISTS (SELECT 1 FROM cost_ledger c WHERE c.reservation_id = r.id)
      AND NOT EXISTS (SELECT 1 FROM idempotency i WHERE i.reservation_id = r.id)
      AND NOT EXISTS (SELECT 1 FROM leases l WHERE l.reservation_id = r.id);
  GET DIAGNOSTICS n_reservations = ROW_COUNT;
  PERFORM set_config('aviation.pruning_controls', '', true);
  RETURN jsonb_build_object('idempotency', n_idempotency, 'usageBuckets', n_buckets, 'trialIdentities', n_trials,
    'turnstileRedemptions', n_redemptions, 'abuseRecords', n_abuse, 'costLedger', n_ledger, 'leases', n_leases,
    'reservations', n_reservations, 'briefs', n_briefs, 'briefSteps', n_brief_steps);
END $$;
