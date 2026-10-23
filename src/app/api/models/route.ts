import { resolveAvailableModels } from "@/lib/models/catalog";
export const dynamic = "force-dynamic";
export async function GET(): Promise<Response> {
  const models = await resolveAvailableModels();
  return Response.json({ fixed: true, models: models.map(m => ({
    id: m.id, name: m.name, provider: m.provider, providerName: m.providerName,
    supportsThinking: true, supportsVision: true, maxTokens: m.capabilities.maxTokens,
    defaultThinking: true, defaultEffort: "high",
  })) });
}
