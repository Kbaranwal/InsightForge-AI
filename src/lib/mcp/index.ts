import { auth, defineMcp } from "@lovable.dev/mcp-js";
import listDatasets from "./tools/list-datasets";
import getDataset from "./tools/get-dataset";
import listActivity from "./tools/list-activity";

// Use the direct Supabase issuer, never the .lovable.cloud proxy — mcp-js
// rejects tokens whose configured issuer doesn't match the one advertised in
// the discovery document.
const projectRef = import.meta.env.VITE_SUPABASE_PROJECT_ID ?? "project-ref-unset";

export default defineMcp({
  name: "insightiq-mcp",
  title: "InsightForge AI",
  version: "0.1.0",
  instructions:
    "Tools for InsightForge AI. Use `list_datasets` to see the user's uploaded datasets, `get_dataset` to fetch a dataset with its latest AI analysis (dashboard, insights, forecasts, report), and `list_activity` for recent audit-log activity. All tools act as the signed-in user; row-level security scopes results to that user.",
  auth: auth.oauth.issuer({
    issuer: `https://${projectRef}.supabase.co/auth/v1`,
    acceptedAudiences: "authenticated",
  }),
  tools: [listDatasets, getDataset, listActivity],
});
