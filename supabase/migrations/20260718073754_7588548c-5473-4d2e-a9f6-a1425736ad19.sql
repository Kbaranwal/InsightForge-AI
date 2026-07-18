
-- Lock down SECURITY DEFINER trigger functions
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) FROM PUBLIC, anon;
ALTER FUNCTION public.tg_set_updated_at() SET search_path = public;
REVOKE EXECUTE ON FUNCTION public.tg_set_updated_at() FROM PUBLIC, anon, authenticated;

-- Storage RLS for the private 'datasets' bucket (per-user folder prefix = user_id)
CREATE POLICY "Users read own dataset files" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'datasets' AND auth.uid()::text = (storage.foldername(name))[1]);
CREATE POLICY "Users upload own dataset files" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'datasets' AND auth.uid()::text = (storage.foldername(name))[1]);
CREATE POLICY "Users delete own dataset files" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'datasets' AND auth.uid()::text = (storage.foldername(name))[1]);
