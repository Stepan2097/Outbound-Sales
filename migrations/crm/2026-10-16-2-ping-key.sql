-- CRM (crm-db) · пінги Outbound без службового рядка в описі, таск 969fc5ee · застосовано 16.10.2026.
-- Ключ пінга живе в tasks.ping_key, «замінено» — у tasks.ping_superseded; опис задачі — лише людський текст.
-- Запуск: docker exec -i crm-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 < цей файл
-- Бекап задач: /root/crm-fixes/ping-key-before-2026-10-16.sql. Код Outbound (65b92bd+) пише ці колонки:
-- розгортати його лише після цієї міграції. Код читає й старий формат (рядок ⟦ob:…⟧ в описі), тож порядок
-- «міграція → дочищення» безпечний і на живій звірці.

begin;

alter table public.tasks add column if not exists ping_key text;
alter table public.tasks add column if not exists ping_superseded boolean default false;
create index if not exists tasks_ping_key_idx on public.tasks (contact_id, ping_key) where queue = 'Outbound';

-- Старі описи — у резервну таблицю, щоб відкат повернув їх слово в слово.
create table if not exists public.zz_ping_desc_backup_20261016 as
  select id, description from public.tasks where description like '%⟦ob:%';

-- Ключ і «замінено» з опису — у колонки.
update public.tasks t
   set ping_key = (select m[1] from regexp_matches(t.description, '⟦ob:([^⟧]+)⟧', 'g') as m where m[1] <> 'superseded' limit 1)
 where t.queue = 'Outbound' and t.ping_key is null and t.description like '%⟦ob:%';
update public.tasks set ping_superseded = true
 where queue = 'Outbound' and description like '%⟦ob:superseded⟧%';

-- Дочищення: опис без рядків ⟦ob:…⟧.
update public.tasks
   set description = btrim(regexp_replace(description, E'\\n?⟦ob:[^⟧]*⟧', '', 'g'))
 where description like '%⟦ob:%';

commit;
notify pgrst, 'reload schema';

-- Перевірка (очікується 0):
-- select count(*) from public.tasks where description like '%⟦ob:%';
-- select count(*) from public.tasks where queue = 'Outbound' and ping_key is null and origin = 'outbound';

-- Відкат:
-- begin;
-- update public.tasks t set description = b.description from public.zz_ping_desc_backup_20261016 b where b.id = t.id;
-- drop index if exists public.tasks_ping_key_idx;
-- alter table public.tasks drop column ping_key, drop column ping_superseded;
-- commit;
-- notify pgrst, 'reload schema';
