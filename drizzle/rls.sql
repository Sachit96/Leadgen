-- Row Level Security for Supabase (and any deployment where the app connects
-- as a non-privileged role).
--
-- These policies are DEFENCE IN DEPTH, not the primary control. On Radar's
-- service layer requires an explicit organization id on every query (see
-- src/lib/auth/context.ts), and most deployments connect as the owner or the
-- Supabase service role, which bypasses RLS entirely. Apply this file when you
-- also expose the database directly — for example to Supabase client libraries
-- or a BI tool — so a mistake there cannot cross a tenant boundary.
--
-- Usage:
--   psql "$DATABASE_URL" -f drizzle/rls.sql
--
-- The current organization is read from a session GUC. Set it per connection:
--   select set_config('app.organization_id', '<uuid>', true);

create or replace function app_current_organization() returns uuid
language sql stable
as $$
  select nullif(current_setting('app.organization_id', true), '')::uuid;
$$;

do $$
declare
  tenant_table text;
begin
  foreach tenant_table in array array[
    'org_settings', 'companies', 'contacts', 'provider_accounts', 'phone_numbers',
    'campaigns', 'campaign_steps', 'campaign_variants', 'campaign_memberships',
    'conversations', 'messages', 'message_events', 'outbound_jobs',
    'ai_prompts', 'ai_runs', 'ai_summaries', 'qualifications',
    'knowledge_entries', 'objections', 'appointments', 'pipeline_deals',
    'activities', 'tasks', 'notifications', 'suppression_entries',
    'experiments', 'audit_logs', 'import_batches', 'sessions', 'memberships'
  ]
  loop
    execute format('alter table %I enable row level security', tenant_table);
    execute format('alter table %I force row level security', tenant_table);
    execute format('drop policy if exists tenant_isolation on %I', tenant_table);
    execute format(
      'create policy tenant_isolation on %I using (organization_id = app_current_organization())'
      ' with check (organization_id = app_current_organization())',
      tenant_table
    );
  end loop;
end
$$;

-- Organizations are visible only as the one the session is scoped to.
alter table organizations enable row level security;
alter table organizations force row level security;
drop policy if exists tenant_isolation on organizations;
create policy tenant_isolation on organizations
  using (id = app_current_organization())
  with check (id = app_current_organization());

-- Users are shared across organizations (one person can belong to several), so
-- visibility is derived from co-membership rather than a column on the row.
alter table users enable row level security;
alter table users force row level security;
drop policy if exists tenant_isolation on users;
create policy tenant_isolation on users
  using (
    exists (
      select 1 from memberships m
      where m.user_id = users.id
        and m.organization_id = app_current_organization()
    )
  );
