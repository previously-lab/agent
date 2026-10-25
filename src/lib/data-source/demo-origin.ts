import { join } from "node:path";

export function getDemoDatasetOrigin(): { transport: "remote" | "local"; root: string } {
  const remote = process.env.BENCHMARK_BASE_URL ?? "";
  return remote
    ? { transport: "remote", root: remote }
    : { transport: "local", root: join(process.cwd(), "..", "you") };
}
