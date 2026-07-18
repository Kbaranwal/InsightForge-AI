import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

export function createGateway() {
  const key = process.env.LOVABLE_API_KEY;
  if (!key) throw new Error("Missing LOVABLE_API_KEY");
  return createOpenAICompatible({
    name: "lovable",
    baseURL: "https://ai.gateway.lovable.dev/v1",
    headers: {
      "Lovable-API-Key": key,
      "X-Lovable-AIG-SDK": "vercel-ai-sdk",
    },
  });
}

export const DEFAULT_MODEL = "google/gemini-2.5-flash";
export const HEAVY_MODEL = "google/gemini-2.5-pro";
