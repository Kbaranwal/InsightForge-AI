# InsightForge AI

AI-powered analytics SaaS. Upload any CSV or Excel, and a multi-agent AI pipeline auto-detects the schema, computes KPIs, generates an executive dashboard, writes insights, projects forecasts, and lets you chat with your data — all grounded strictly in the uploaded dataset.

Built on a modern edge stack: TanStack Start (React 19 + Vite + SSR), Tailwind v4, shadcn/ui, Framer Motion, Recharts, Supabase (Postgres + Auth + Storage) and a hosted AI gateway (Google Gemini 2.5 Flash + Pro) for all AI.

## Features

- **Auth** — Email/password + Google OAuth, password reset, protected routes
- **Upload** — CSV/XLSX up to 100 MB, client-side parsed with PapaParse / SheetJS, progress + validation
- **Multi-agent AI pipeline**
  - Data Cleaning + Column Profiling (types, missing, unique, min/max, mean, stddev, top values)
  - Dataset Understanding agent (domain, key entities, PII, metric vs dimension columns)
  - Dashboard Generation agent (KPIs + charts with explanations, typed spec)
  - Insight + Anomaly + Recommendation agents (evidence-linked, impact-scored)
  - Forecasting agent (linear regression on detected time series, +6 periods)
  - Report Generation agent (5-8 section narrative report + conclusion)
  - Chat Analyst (streaming, grounded in schema + sample rows)
- **Dashboard engine** — Auto-selected chart types (line, bar, area, pie, scatter, table) rendered with Recharts
- **Forecasts tab** — Projected series with reference line and change % badge
- **Report tab** — Full narrative report, downloadable as PDF
- **Exports** — PDF, PowerPoint (.pptx), Word (.docx), Excel (.xlsx), CSV
- **Activity log** — Every action (upload, analysis, report, delete) with metadata
- **Rate limiting** — Ad-hoc per-user hourly caps on analysis runs and report generation
- **Security** — Postgres RLS on every table, private per-user Storage bucket, secure OAuth via managed broker
- **Design** — Modern dark/light SaaS aesthetic, glass cards, motion transitions, skeleton loaders

## Architecture

```
Browser (React 19 + TanStack Router)
  │
  ├── Client parses CSV/XLSX, uploads original to Supabase Storage
  ├── Calls createServerFn RPCs (bearer-attached Supabase session)
  │
  ▼
TanStack Server Functions  (Cloudflare Workers runtime)
  │
  ├── createDataset       → profile columns, persist metadata
  ├── analyzeDataset      → orchestrate AI agents  ─┐
  ├── generateReport      → narrative report agent  │──► AI Gateway
  ├── /api/chat  (route)  → streamText chat analyst │        (Gemini 2.5)
  ├── listDatasets / getDataset / deleteDataset     │
  └── listAuditLogs                                 ▼
                                             AI SDK v4
  │
  ▼
Supabase Postgres (RLS everywhere)
  profiles · user_roles · datasets · analyses · chat_messages · audit_logs
  Storage bucket: datasets (private, per-user folder isolation)
```

## Folder structure

```
src/
  routes/                 File-based routes (TanStack Router)
    __root.tsx            Shell, providers, SEO
    index.tsx             Landing (public, SSR + SEO)
    auth.tsx              Sign in / sign up
    reset-password.tsx    Password reset
    sitemap[.]xml.ts      Dynamic sitemap
    api/chat.ts           Streaming chat endpoint
    _authenticated.tsx    Auth gate + sidebar layout
    _authenticated.dashboard.tsx
    _authenticated.upload.tsx
    _authenticated.datasets.$id.tsx   Dashboard/Insights/Forecasts/Report/Chat/Data
    _authenticated.activity.tsx       Audit log
    _authenticated.settings.tsx
  lib/
    datasets.functions.ts AI agents + rate limiting + audit logging (server fns)
    ai-gateway.server.ts  AI Gateway provider
    exports.ts            CSV/XLSX/PDF/PPTX/DOCX generators + report PDF
  components/
    chart-renderer.tsx    Typed chart spec → Recharts
    chat-panel.tsx        useChat streaming UI
    ui/                   shadcn primitives
  integrations/supabase/  Auto-generated clients + middleware
  styles.css              Tailwind v4 theme + design tokens
```

## Installation

Prereqs: Node 20+, Bun (or pnpm), a Supabase project.

```bash
bun install
bun run dev              # http://localhost:8080
```

Required env (managed by the platform):

```
VITE_SUPABASE_URL
VITE_SUPABASE_PUBLISHABLE_KEY
VITE_SUPABASE_PROJECT_ID
SUPABASE_URL
SUPABASE_PUBLISHABLE_KEY
SUPABASE_SERVICE_ROLE_KEY
LOVABLE_API_KEY                     # AI Gateway
```

## Deployment

Deploy the stack is a single Vite build that runs SSR on Cloudflare Workers. Database, auth, storage, and the AI Gateway are managed by Supabase. No FastAPI, Vercel, or Render setup required.

## User guide

1. **Sign up** with email or Google.
2. **New analysis** → drop a CSV or XLSX. Rows are parsed client-side, a sample is persisted, and the AI pipeline kicks off automatically.
3. Watch the **Dashboard** tab hydrate as agents finish (Understanding → Dashboard → Insights → Forecasts).
4. Open the **Insights** tab for evidence-linked findings, anomalies, and recommendations.
5. Open **Forecasts** for projected series with the historical/projected split.
6. Open **Report** and click *Generate report* for a full narrative report — export it as PDF.
7. Open **Chat** to ask questions grounded in your dataset's schema and sample.
8. Use the top-right **Export** menu for PDF, PPTX, DOCX, XLSX, or CSV.
9. Track everything you've done in **Activity**.

## Security

- Every table has RLS scoped to `auth.uid()`; roles live in the separate `user_roles` table with a `has_role` security-definer function (no privilege escalation).
- Storage bucket `datasets` is private, RLS-scoped by folder to the owning user.
- No service-role key ships to the browser; only server functions use it, and only when authorization has been verified.
- OAuth flows go through the managed OAuth broker (iframe-safe).
- Ad-hoc per-user hourly rate limits on `analysis.run` (20/hr) and `report.generate` (10/hr).

## API surface

All server-side logic is exposed through TanStack `createServerFn` RPCs (typed, bearer-authenticated) or the streaming `/api/chat` route. There is no separate REST layer — TanStack Start replaces the need for a standalone FastAPI/Express service.

| RPC                    | Purpose                                        |
| ---------------------- | ---------------------------------------------- |
| `createDataset`        | Persist parsed dataset + column profile        |
| `listDatasets`         | List the user's datasets                       |
| `getDataset`           | Fetch dataset + latest analysis                |
| `deleteDataset`        | Delete dataset + storage object + audit        |
| `analyzeDataset`       | Run the full multi-agent AI pipeline           |
| `generateReport`       | Generate the narrative report                  |
| `listAuditLogs`        | Return the user's last 200 events              |
| `POST /api/chat`       | Streaming chat analyst grounded in the dataset |

## License

MIT
