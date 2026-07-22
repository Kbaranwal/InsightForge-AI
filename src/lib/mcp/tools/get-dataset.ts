import { createClient } from "@supabase/supabase-js";
import { defineTool, type ToolContext } from "@lovable.dev/mcp-js";
import { z } from "zod";

function supabaseForUser(ctx: ToolContext) {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
    global: { headers: { Authorization: `Bearer ${ctx.getToken()}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export default defineTool({
  name: "get_dataset",
  title: "Get dataset",
  description:
    "Fetch a dataset by ID along with its latest AI analysis (understanding, dashboard spec, insights, forecasts, and report if generated).",
  inputSchema: {
    id: z.string().uuid().describe("Dataset ID (UUID) from list_datasets."),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ id }, ctx) => {
    if (!ctx.isAuthenticated()) {
      return { content: [{ type: "text", text: "Not authenticated" }], isError: true };
    }
    const sb = supabaseForUser(ctx);
    const { data: dataset, error } = await sb.from("datasets").select("*").eq("id", id).single();
    if (error) return { content: [{ type: "text", text: error.message }], isError: true };
    const { data: analysis } = await sb
      .from("analyses")
      .select("*")
      .eq("dataset_id", id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    return {
      content: [{ type: "text", text: JSON.stringify({ dataset, analysis }, null, 2) }],
      structuredContent: { dataset, analysis },
    };
  },
});
