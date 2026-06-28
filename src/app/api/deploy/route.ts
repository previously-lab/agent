import { triggerDeploy } from "@/lib/deploy/trigger";

export async function POST() {
  const result = triggerDeploy();
  return new Response(JSON.stringify(result), {
    status: result.success ? 200 : 500,
    headers: { "Content-Type": "application/json" },
  });
}
