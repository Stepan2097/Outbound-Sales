CREATE TABLE public.contacts (
  id uuid PRIMARY KEY, folder_id uuid NOT NULL, name text, company text, email text, position text,
  country text, phone text, linkedin text, telegram text, lead_status text, created_at timestamptz DEFAULT now()
);
INSERT INTO public.contacts (id, folder_id, name, company, email, position)
SELECT md5('contact' || n)::uuid, '11111111-1111-4111-8111-111111111111',
  CASE WHEN n % 3 = 0 THEN 'Michael ' WHEN n % 3 = 1 THEN 'Nina ' ELSE 'Owen ' END || n,
  CASE WHEN n % 7 = 0 THEN 'Conventus Capital' ELSE 'Company ' || n END,
  'person' || n || '@example.com', CASE WHEN n % 2 = 0 THEN 'Account Manager' ELSE 'Director of Growth' END
FROM generate_series(1, 27594) n;
INSERT INTO public.contacts (id, folder_id, name, company, email, position) VALUES
 ('00000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'Michaél Spyrka', 'Conventus Capital', 'michael@example.com', 'equity trader'),
 ('00000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', 'abc', 'wild%_company', 'test@example.org', 'manager'),
 ('00000000-0000-4000-8000-000000000003', '11111111-1111-4111-8111-111111111111', 'Åndré Sâr', 'Renée & Co', 'andre@example.org', 'designer'),
 ('00000000-0000-4000-8000-000000000004', '33333333-3333-4333-8333-333333333333', 'Michael', 'Other folder', 'hidden@example.org', 'manager');
