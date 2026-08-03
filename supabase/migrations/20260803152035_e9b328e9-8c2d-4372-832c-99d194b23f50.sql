ALTER TABLE public.analyses ADD COLUMN IF NOT EXISTS anomalies jsonb;

CREATE TABLE IF NOT EXISTS public.pinned_widgets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  dataset_id uuid NOT NULL REFERENCES public.datasets(id) ON DELETE CASCADE,
  question text NOT NULL,
  intent jsonb NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.pinned_widgets TO authenticated;
GRANT ALL ON public.pinned_widgets TO service_role;

ALTER TABLE public.pinned_widgets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage own pinned widgets" ON public.pinned_widgets;
CREATE POLICY "Users manage own pinned widgets" ON public.pinned_widgets
  FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS pinned_widgets_dataset_idx ON public.pinned_widgets (dataset_id, created_at DESC);