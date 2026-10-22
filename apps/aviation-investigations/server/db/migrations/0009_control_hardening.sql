ALTER TABLE "reservations" ADD CONSTRAINT "reservations_uncertain_check" CHECK ("reservations"."status" <> 'settled' or not "reservations"."uncertain" or "reservations"."charged_usd" >= "reservations"."usd");--> statement-breakpoint
-- aviation_ingest reads only indexing and evaluation spend: interactive rows carry
-- principal HMACs and fencing tokens. The cross-category monthly totals it needs for
-- the shared $100 budget come from spend_totals(), which returns sums only.
DROP POLICY reservations_ingest_read ON "reservations";
--> statement-breakpoint
CREATE POLICY reservations_ingest_read ON "reservations" FOR SELECT TO aviation_ingest
  USING (category IN ('indexing', 'evaluation'));
--> statement-breakpoint
DROP POLICY cost_ledger_ingest_read ON "cost_ledger";
--> statement-breakpoint
CREATE POLICY cost_ledger_ingest_read ON "cost_ledger" FOR SELECT TO aviation_ingest
  USING (category IN ('indexing', 'evaluation'));
--> statement-breakpoint
-- Month-to-date spend for the UTC month of p_today, in whole micro-dollars: ledger
-- lines plus the full amount of open reservations, by accounting day. One statement,
-- so the sums come from one snapshot. No identities, tokens or rows leave it.
CREATE FUNCTION spend_totals(p_today date)
RETURNS TABLE (settled_before bigint, open_before bigint, today bigint, anon_today bigint,
  interactive_month bigint, ingestion_month bigint, total_month bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH bounds AS (
    SELECT date_trunc('month', p_today)::date AS m_from,
      (date_trunc('month', p_today) + interval '1 month')::date AS m_to
  ), spend AS (
    SELECT l.category, l.principal_kind, l.accounting_day, l.usd, false AS open
      FROM cost_ledger l, bounds b WHERE l.accounting_day >= b.m_from AND l.accounting_day < b.m_to
    UNION ALL
    SELECT r.category, r.principal_kind, r.accounting_day, r.usd, true AS open
      FROM reservations r, bounds b
      WHERE r.status = 'open' AND r.accounting_day >= b.m_from AND r.accounting_day < b.m_to
  )
  SELECT
    (coalesce(sum(usd) FILTER (WHERE category = 'interactive' AND accounting_day < p_today AND NOT open), 0) * 1000000)::bigint,
    (coalesce(sum(usd) FILTER (WHERE category = 'interactive' AND accounting_day < p_today AND open), 0) * 1000000)::bigint,
    (coalesce(sum(usd) FILTER (WHERE category = 'interactive' AND accounting_day = p_today), 0) * 1000000)::bigint,
    (coalesce(sum(usd) FILTER (WHERE category = 'interactive' AND accounting_day = p_today AND principal_kind = 'trial'), 0)
      * 1000000)::bigint,
    (coalesce(sum(usd) FILTER (WHERE category = 'interactive'), 0) * 1000000)::bigint,
    (coalesce(sum(usd) FILTER (WHERE category IN ('indexing', 'evaluation')), 0) * 1000000)::bigint,
    (coalesce(sum(usd), 0) * 1000000)::bigint
  FROM spend
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION spend_totals(date) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION spend_totals(date) TO aviation_app, aviation_ingest;
