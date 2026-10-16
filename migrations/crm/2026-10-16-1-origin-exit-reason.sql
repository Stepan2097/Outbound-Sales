-- CRM (crm-db, self-hosted Supabase на 169.58.60.245) · етап 5/6, таск a70031f9 · застосовано 16.10.2026.
-- Мітка джерела «Outbound» на дотиках, пінгах і угодах; причина виходу контакту — закритий список.
-- Запуск: docker exec -i crm-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 < цей файл
-- Бекап перед запуском: /root/crm-fixes/stage5-before-migration-2026-10-16.sql (activities, tasks, deals, deal_contacts).
-- Код Outbound (432ee05+) і фронтенд CRM (5b2a8c5+) пишуть ці колонки: розгортати їх лише після цієї міграції.

begin;

alter table public.activities add column if not exists origin text;
alter table public.tasks add column if not exists origin text;
alter table public.deals add column if not exists origin text;

alter table public.contacts add column if not exists exit_reason text;
alter table public.contacts drop constraint if exists contacts_exit_reason_check;
alter table public.contacts add constraint contacts_exit_reason_check check (
  exit_reason is null or exit_reason = any (array['not_icp', 'no_budget', 'has_team', 'traffic_only', 'not_now', 'no_reply', 'other'])
);

-- Наявні рядки Outbound: пінги — черга Outbound; дотики — без автора-людини, з префіксами, які пише Outbound.
update public.tasks set origin = 'outbound' where queue = 'Outbound' and origin is null;
update public.activities set origin = 'outbound'
 where origin is null and user_id is null
   and (content like 'LinkedIn · %' or content like 'Outbound:%' or content like 'Outbound OS interaction:%');

commit;
notify pgrst, 'reload schema';

-- Відкат:
-- begin;
-- alter table public.activities drop column origin;
-- alter table public.tasks drop column origin;
-- alter table public.deals drop column origin;
-- alter table public.contacts drop constraint contacts_exit_reason_check;
-- alter table public.contacts drop column exit_reason;
-- commit;
-- notify pgrst, 'reload schema';
