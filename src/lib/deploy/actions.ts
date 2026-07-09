"use server";

import { triggerDeploy, type DeployResult } from "./trigger";

/**
 * Trigger a Vercel deployment ([deploy] commit + push).
 * Called directly from client components — replaces the old POST /api/deploy route.
 */
export async function deploy(): Promise<DeployResult> {
  return triggerDeploy();
}
