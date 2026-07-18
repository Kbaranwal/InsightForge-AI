# InsightIQ — AI Analytics SaaS

Building on Lovable stack: TanStack Start + React + Tailwind + shadcn + Framer Motion, Lovable Cloud (Supabase) for DB/auth/storage, Lovable AI Gateway for all AI. FastAPI/Vercel/Render are replaced by this equivalent, single-deploy stack (same capabilities).

## Product

Upload any CSV/Excel → AI auto-detects schema, KPIs, chart types → generates a live dashboard with executive summary, insights, anomalies, recommendations, forecasts → chat with your data → export.

## Phasing (I'll build Phase 1 now, then confirm before each next phase)

**Phase 1 — Foundation + Auto-Dashboard MVP (this turn)**
- Design system: dark/light, modern SaaS aesthetic (Linear/Vercel inspired), semantic tokens in `styles.css`
- Auth: email/password + Google, password reset, protected `_authenticated/*` routes, profile
- Landing page (public, SEO), Auth page, Dashboard app shell with sidebar
- Cloud schema: `profiles`, `user_roles` (secure pattern), `datasets`, `dataset_rows` (JSONB), `analyses`, `chat_messages`, `audit_logs` — all with RLS + GRANTs
- Storage bucket `datasets` (private) with per-user RLS
- CSV/XLSX upload (client-parsed with PapaParse/SheetJS, streamed into `dataset_rows`, up to 100 MB with row cap + progress)
- **Data Cleaning + Understanding agents** (server fn, Gemini): infer types, detect PII, missing values, outliers, semantic column roles
- **Dashboard Generation agent**: outputs a typed chart spec (KPI cards, line/bar/area/pie/scatter/table) rendered with Recharts, each chart carries an AI-written explanation
- **Insight + Recommendation agents**: bulleted, evidence-linked
- **AI Chat Analyst**: streaming chat scoped to the dataset (uses dataset schema + sampled rows + aggregates as context; never hallucinates outside data)
- Skeleton loaders, empty/error/retry states, toasts, framer-motion transitions
- Sitemap + robots, SEO metadata per route

**Phase 2 — Forecasting, Anomalies, Exports**
- Forecasting agent (simple statistical + LLM narrative) on detected time-series
- Anomaly agent with highlighted points on charts
- Export: PDF (dashboard + insights + summary), Excel, CSV, PPTX, DOCX via server fns

**Phase 3 — Polish + Ops**
- Report Generation agent (full narrative report)
- Rate limiting, audit log UI, usage/credits view
- Team workspaces (optional), sharing links
- README, API docs, architecture diagram, user guide

## Technical notes

- All AI via `@ai-sdk/openai-compatible` → Lovable AI Gateway with `google/gemini-2.5-flash` default, `gemini-2.5-pro` for heavier synthesis
- Server functions (`createServerFn`) for all AI + privileged DB work; `requireSupabaseAuth` middleware
- Chart spec is a strict typed schema; renderer is a switch over `type`
- Chat uses `useChat` + `/api/chat` streaming route with dataset context injected server-side
- Row storage: JSONB per row keyed by dataset; aggregations computed server-side and cached in `analyses`

## Deliverable for this turn

A running, polished Phase 1: sign up → upload CSV → watch AI generate a real dashboard from your data → chat with it. Production-quality code, no mocks, no TODOs.

After Phase 1 lands and you've kicked the tires, say "go phase 2" and I'll build exports + forecasting.