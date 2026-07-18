import { createFileRoute } from "@tanstack/react-router";
import { convertToCoreMessages, streamText, type Message } from "ai";
import { createClient } from "@supabase/supabase-js";
import { createGateway, DEFAULT_MODEL } from "@/lib/ai-gateway.server";
import type { Database } from "@/integrations/supabase/types";
import type { ColumnMeta } from "@/lib/datasets.functions";

export const Route = createFileRoute("/api/chat")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const body = (await request.json()) as { messages?: Message[]; datasetId?: string };
          const messages = body.messages;
          const datasetId = body.datasetId;
          if (!Array.isArray(messages) || !datasetId) return new Response("Bad request", { status: 400 });

          const auth = request.headers.get("authorization") ?? "";
          const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
          if (!token) return new Response("Unauthorized", { status: 401 });

          const url = process.env.SUPABASE_URL!;
          const key = process.env.SUPABASE_PUBLISHABLE_KEY!;
          const supabase = createClient<Database>(url, key, {
            global: { headers: { Authorization: `Bearer ${token}` } },
            auth: { persistSession: false, autoRefreshToken: false },
          });
          const { data: user } = await supabase.auth.getUser(token);
          if (!user.user) return new Response("Unauthorized", { status: 401 });

          const { data: ds, error } = await supabase.from("datasets").select("*").eq("id", datasetId).single();
          if (error || !ds) return new Response("Not found", { status: 404 });

          const cols = ds.columns as unknown as ColumnMeta[];
          const sample = (ds.sample_rows as unknown as Array<Record<string, unknown>>).slice(0, 25);
          const colDesc = cols.map((c) => `${c.name} [${c.type}] unique=${c.unique} missing=${c.missing}`).join("\n");

          const system = `You are InsightIQ, an AI data analyst. You answer ONLY based on the user's dataset below.
If a question cannot be answered from this data, say so honestly.
Cite specific columns and numeric values when possible. Keep answers concise, well-structured, and use markdown tables when helpful.

DATASET "${ds.name}" (${ds.row_count.toLocaleString()} rows, ${cols.length} columns)

COLUMNS:
${colDesc}

SAMPLE ROWS (JSON, first ${sample.length}):
${JSON.stringify(sample).slice(0, 6000)}`;

          // persist the last user message
          const last = messages[messages.length - 1];
          if (last?.role === "user") {
            await supabase.from("chat_messages").insert({
              user_id: user.user.id, dataset_id: datasetId, role: "user", content: String(last.content).slice(0, 8000),
            });
          }

          const gateway = createGateway();
          const result = streamText({
            model: gateway(DEFAULT_MODEL),
            system,
            messages: convertToCoreMessages(messages),
            temperature: 0.3,
            async onFinish({ text }) {
              await supabase.from("chat_messages").insert({
                user_id: user.user.id, dataset_id: datasetId, role: "assistant", content: text.slice(0, 16000),
              });
            },
          });
          return result.toDataStreamResponse();
        } catch (e) {
          console.error("chat error", e);
          return new Response(e instanceof Error ? e.message : "Error", { status: 500 });
        }
      },
    },
  },
});
