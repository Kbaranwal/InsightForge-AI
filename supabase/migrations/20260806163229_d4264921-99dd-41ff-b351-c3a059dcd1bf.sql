REVOKE EXECUTE ON FUNCTION public.has_role(uuid, app_role) FROM authenticated, anon, PUBLIC;

CREATE POLICY "Users update own dataset files"
ON storage.objects FOR UPDATE TO authenticated
USING (bucket_id = 'datasets' AND (auth.uid())::text = (storage.foldername(name))[1])
WITH CHECK (bucket_id = 'datasets' AND (auth.uid())::text = (storage.foldername(name))[1]);