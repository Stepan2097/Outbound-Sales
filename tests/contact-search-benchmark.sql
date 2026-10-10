\timing on
SET statement_timeout = '20s';
SELECT 'Michael' query, array_agg(id ORDER BY ordinality) ids FROM public.outbound_search_contacts('11111111-1111-4111-8111-111111111111', 'Michael') WITH ORDINALITY AS c;
SELECT 'Mic' query, array_agg(id ORDER BY ordinality) ids FROM public.outbound_search_contacts('11111111-1111-4111-8111-111111111111', 'Mic') WITH ORDINALITY AS c;
SELECT 'Micheal' query, array_agg(id ORDER BY ordinality) ids FROM public.outbound_search_contacts('11111111-1111-4111-8111-111111111111', 'Micheal') WITH ORDINALITY AS c;
SELECT 'Åndré' query, array_agg(id ORDER BY ordinality) ids FROM public.outbound_search_contacts('11111111-1111-4111-8111-111111111111', 'Åndré') WITH ORDINALITY AS c;
SELECT 'bca' query, array_agg(id ORDER BY ordinality) ids FROM public.outbound_search_contacts('11111111-1111-4111-8111-111111111111', 'bca') WITH ORDINALITY AS c;
SELECT '%_' query, array_agg(id ORDER BY ordinality) ids FROM public.outbound_search_contacts('11111111-1111-4111-8111-111111111111', '%_') WITH ORDINALITY AS c;
SELECT 'no-such-contact' query, array_agg(id ORDER BY ordinality) ids FROM public.outbound_search_contacts('11111111-1111-4111-8111-111111111111', 'no-such-contact') WITH ORDINALITY AS c;
EXPLAIN (ANALYZE, BUFFERS) SELECT id FROM public.contacts
WHERE folder_id = '11111111-1111-4111-8111-111111111111'
AND public.outbound_search_document(name, company, email, position) LIKE '%michael%';
