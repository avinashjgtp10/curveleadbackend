-- READ-ONLY diagnostics for Phase 1 stage / conversion accuracy. SELECTs only; run via
-- scripts/stageIntegrityDiagnostics.js (read-only transaction, one savepoint per statement).
-- Output is counts, stage names (workspace configuration) and workspace ids. It never selects lead names,
-- phones, emails, notes or tokens. Statements are separated by a line "-- @@ name".

-- @@ triggers_present
-- The milestone code relies on these. 'O' = enabled.
SELECT t.tgname, t.tgenabled, c.relname AS table_name
FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
WHERE NOT t.tgisinternal AND t.tgname IN ('lead_transition_history', 'phase4_lead_events_trigger', 'automation_lead_stop')
ORDER BY 1;

-- @@ stage_config
-- Every workspace's stages and flags, in pipeline order.
SELECT tenant_id, name, COALESCE(pos, position) AS pos, COALESCE(is_active, true) AS is_active,
       COALESCE(is_won, false) AS is_won, COALESCE(is_lost, false) AS is_lost, COALESCE(is_qualified, false) AS is_qualified
FROM lead_stages ORDER BY tenant_id, COALESCE(pos, position), name;

-- @@ stages_flagged_won_and_lost
SELECT tenant_id, name FROM lead_stages WHERE COALESCE(is_won, false) AND COALESCE(is_lost, false);

-- @@ first_stage_flagged_won_or_lost
-- The first active stage of a workspace (where new leads land) must not be Won or Lost.
SELECT s.tenant_id, s.name, COALESCE(s.is_won, false) AS is_won, COALESCE(s.is_lost, false) AS is_lost
FROM lead_stages s
WHERE COALESCE(s.is_active, true)
  AND COALESCE(s.pos, s.position) = (SELECT min(COALESCE(x.pos, x.position)) FROM lead_stages x WHERE x.tenant_id = s.tenant_id AND COALESCE(x.is_active, true))
  AND (COALESCE(s.is_won, false) OR COALESCE(s.is_lost, false));

-- @@ stages_named_new_flagged_won_or_lost
SELECT tenant_id, name, COALESCE(is_won, false) AS is_won, COALESCE(is_lost, false) AS is_lost
FROM lead_stages WHERE lower(trim(name)) IN ('new', 'new lead', 'new leads', 'lead') AND (COALESCE(is_won, false) OR COALESCE(is_lost, false));

-- @@ workspaces_without_active_won_stage
SELECT t.id AS tenant_id
FROM tenants t WHERE NOT EXISTS (SELECT 1 FROM lead_stages s WHERE s.tenant_id = t.id AND COALESCE(s.is_won, false) AND COALESCE(s.is_active, true))
  AND EXISTS (SELECT 1 FROM leads l WHERE l.tenant_id = t.id);

-- @@ leads_in_a_stage_not_in_the_workspace_config
-- Stage text on the lead that matches no configured stage (unknown to the conversion metrics).
SELECT l.tenant_id, l.stage, count(*)::int AS leads
FROM leads l
WHERE l.merged_into_id IS NULL AND l.stage IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM lead_stages s WHERE s.tenant_id = l.tenant_id AND lower(trim(s.name)) = lower(trim(l.stage)))
GROUP BY 1, 2 ORDER BY leads DESC LIMIT 100;

-- @@ won_leads_without_won_at
SELECT l.tenant_id, count(*)::int AS leads
FROM leads l JOIN lead_stages s ON s.tenant_id = l.tenant_id AND lower(trim(s.name)) = lower(trim(l.stage)) AND COALESCE(s.is_won, false)
WHERE l.merged_into_id IS NULL AND l.won_at IS NULL GROUP BY 1 ORDER BY 2 DESC;

-- @@ leads_with_more_than_one_entry_into_won
-- Re-entries into a won stage (Won -> Lost -> Won, or Won -> Converted): what "first Won" must not double-count.
SELECT tenant_id, count(*)::int AS leads, max(entries)::int AS max_entries FROM (
  SELECT h.tenant_id, h.lead_id, count(*) AS entries
  FROM lead_stage_history h JOIN lead_stages s ON s.tenant_id = h.tenant_id AND lower(trim(s.name)) = lower(trim(h.new_stage)) AND COALESCE(s.is_won, false)
  GROUP BY 1, 2 HAVING count(*) > 1) x
GROUP BY 1 ORDER BY 2 DESC;

-- @@ duplicate_history_rows
-- The same transition recorded twice within 5 seconds (the trigger plus the old explicit insert).
SELECT tenant_id, count(*)::int AS duplicate_pairs FROM (
  SELECT a.tenant_id FROM lead_stage_history a JOIN lead_stage_history b
    ON a.tenant_id = b.tenant_id AND a.lead_id = b.lead_id AND a.new_stage IS NOT DISTINCT FROM b.new_stage
   AND a.prev_stage IS NOT DISTINCT FROM b.prev_stage AND a.ctid < b.ctid AND abs(extract(epoch FROM (a.changed_at - b.changed_at))) < 5) d
GROUP BY 1 ORDER BY 2 DESC;

-- @@ latest_history_disagrees_with_current_stage
SELECT l.tenant_id, count(*)::int AS leads
FROM leads l
JOIN LATERAL (SELECT h.new_stage FROM lead_stage_history h WHERE h.tenant_id = l.tenant_id AND h.lead_id = l.id ORDER BY h.changed_at DESC, h.ctid DESC LIMIT 1) lh ON true
WHERE l.merged_into_id IS NULL AND lower(trim(lh.new_stage)) <> lower(trim(l.stage))
GROUP BY 1 ORDER BY 2 DESC;

-- @@ won_leads_deal_value_summary
-- How much of the won base even has a quoted value (revenue accuracy depends on it). Counts only.
SELECT l.tenant_id, count(*)::int AS won_leads,
       count(*) FILTER (WHERE l.deal_value IS NULL OR l.deal_value = 0)::int AS without_deal_value
FROM leads l JOIN lead_stages s ON s.tenant_id = l.tenant_id AND lower(trim(s.name)) = lower(trim(l.stage)) AND COALESCE(s.is_won, false)
WHERE l.merged_into_id IS NULL GROUP BY 1 ORDER BY 2 DESC;
