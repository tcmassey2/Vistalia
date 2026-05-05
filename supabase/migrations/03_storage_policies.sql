-- EstateMotion storage RLS policies
--
-- Run this in Supabase Dashboard → SQL Editor after creating the
-- `listing-photos` and `generated-videos` buckets.
--
-- Without these policies, every photo upload fails silently with a 403/RLS
-- error and the app shows "We could not save your photos for final export."

-- ============================================================
-- listing-photos: authenticated users upload to their OWN folder.
-- Path convention from the app: {auth.uid()}/projects/{projectId}/{filename}
-- The first path segment must equal the user's UID, which is the standard
-- Supabase Storage isolation pattern.
-- ============================================================

drop policy if exists "listing-photos: authenticated insert own folder"  on storage.objects;
drop policy if exists "listing-photos: authenticated update own folder"  on storage.objects;
drop policy if exists "listing-photos: authenticated delete own folder"  on storage.objects;
drop policy if exists "listing-photos: public read"                      on storage.objects;

create policy "listing-photos: authenticated insert own folder"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'listing-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "listing-photos: authenticated update own folder"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'listing-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "listing-photos: authenticated delete own folder"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'listing-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Anyone (anon + authenticated) can READ photos. Required because the render
-- worker fetches them via public URL when generating the video.
create policy "listing-photos: public read"
  on storage.objects for select
  using ( bucket_id = 'listing-photos' );


-- ============================================================
-- generated-videos: only the render worker writes here (using the service
-- role key, which BYPASSES RLS). End users only read finished MP4s.
-- ============================================================

drop policy if exists "generated-videos: public read" on storage.objects;

create policy "generated-videos: public read"
  on storage.objects for select
  using ( bucket_id = 'generated-videos' );

-- (No insert/update/delete policies needed for generated-videos — the worker
-- uses SUPABASE_SERVICE_ROLE_KEY which bypasses RLS by design.)
