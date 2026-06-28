/**
 * Trigger a Vercel deployment by creating a [deploy] commit and pushing.
 * Requires git to be available (works on Vercel and local dev).
 */
import { execSync } from "child_process";

export interface DeployResult {
  success: boolean;
  message: string;
}

export function triggerDeploy(): DeployResult {
  try {
    // Create empty commit with [deploy] marker
    execSync('git commit --allow-empty -m "[deploy] Manual trigger from Settings"', {
      encoding: "utf-8",
      timeout: 10000,
    });

    // Push to origin
    execSync("git push origin HEAD", {
      encoding: "utf-8",
      timeout: 30000,
    });

    return { success: true, message: "Deployment triggered. Check Vercel for build status." };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : "Unknown error";
    return {
      success: false,
      message: `Deploy failed: ${errMsg}. Make sure git is configured and the repo is connected.`,
    };
  }
}
