import { z } from "zod";
import { tool } from "@/lib/deepseek/tools";
import { buildSubAgentSystem } from "@/lib/agents/prompts";
import { runSubAgent, type SubAgentProgressRef } from "@/lib/agents/sub-agent-runner";
import { describeImage } from "@/lib/vision/describe-image";
import { deepseekWebFetch } from "./deepseek-web";
import { webSearchInputSchema, webFetchInputSchema } from "./web-input";
import { SearchRunPolicy, type SearchRunStats } from "./search-policy";

export interface WebSearchResult {
  answer: string;
  sources: Array<{ title: string; url: string; read?: boolean }>;
  recommendation: string;
  suggestedReads: Array<{ url: string; title: string; reason: string }>;
  searchStats?: SearchRunStats;
}

const reportSchema = z.object({
  answer: z.string().catch(""),
  recommendation: z.string().catch(""),
  suggested_reads: z.array(z.object({
    url: z.string(), title: z.string().catch(""), reason: z.string().catch(""),
  })).catch([]),
});
type Report = z.infer<typeof reportSchema>;

const role = buildSubAgentSystem(`You are an independent researcher. Your colleague delegates a question requiring investigation.
Use focused queries to identify strong sources and open relevant pages when a conclusion depends on their contents. A search summary alone does not establish that you read a page.
Follow new leads when they resolve a material gap, such as conflicting sources, missing primary evidence, or an unclear date. Stop when you can answer the delegated question with its relevant uncertainty.
Return the findings through searchReport, citing source URLs and distinguishing documented facts from inference. Include suggested reads only when they would add something. Use the language of the question.`);

export async function searchViaFlash(
  query: string,
  progress?: SubAgentProgressRef,
  opts?: { scout?: boolean; sessionId?: string; abortSignal?: AbortSignal },
): Promise<WebSearchResult> {
  const policy = new SearchRunPolicy();
  const observed = new Map<string, { title: string; url: string; read: boolean }>();
  const scope = opts?.scout ? "\nInvestigate this part of the larger question independently." : "";
  const response = await runSubAgent<Report>({
    role: "search",
    system: role,
    selfSop: "search",
    sessionId: opts?.sessionId,
    abortSignal: opts?.abortSignal,
    prompt: `Today is ${new Date().toISOString().slice(0, 10)}.\n\nQuery: ${query}${scope}`,
    tools: {
      web_search: tool({
        description: "Search for source titles, URLs and summaries. Open a source to verify the relevant passage.",
        inputSchema: webSearchInputSchema,
        execute: async (input, options) => {
          const results = await policy.search(input, options?.abortSignal);
          for (const source of results.results) {
            if (!observed.has(source.url)) observed.set(source.url, { url: source.url, title: source.title || source.url, read: false });
          }
          return results;
        },
      }),
      webFetch: tool({
        description: "Read a public page as Markdown. Use a returned offset to continue the same selection.",
        inputSchema: webFetchInputSchema,
        execute: async (input, options) => {
          const page = await deepseekWebFetch(input, options?.abortSignal);
          if (page.trim() && !page.startsWith("ERROR:")) {
            observed.set(input.url, { title: observed.get(input.url)?.title ?? input.url, url: input.url, read: true });
          }
          return page;
        },
      }),
      viewImage: tool({
        description: "Inspect an image when the source's relevant evidence is visual.",
        inputSchema: z.object({ url: z.string(), question: z.string().optional() }),
        execute: async ({ url, question }) => {
          const result = await describeImage({ image: { url }, question, sessionId: opts?.sessionId });
          return result.ok ? result.description : result.error;
        },
      }),
      searchReport: tool({ description: "Return the answer, sources and remaining uncertainty to your colleague.", inputSchema: reportSchema }),
    },
    toolChoice: "auto",
    reportToolName: "searchReport",
    reportSchema,
    progress,
    onToolProgress: ({ toolName }) => {
      if (toolName === "web_search") return { line: "Searching the web…", stage: "running" };
      if (toolName === "webFetch") return { line: "Reading a source…", stage: "running" };
      if (toolName === "viewImage") return { line: "Examining an image…", stage: "running" };
      if (toolName === "searchReport") return { line: "Writing the research findings…", stage: "running" };
    },
  });
  opts?.abortSignal?.throwIfAborted();
  if (!response.ok && !response.text?.trim()) throw new Error(response.error ?? "Web research failed");
  const report = response.report;
  return {
    answer: report?.answer || response.text,
    recommendation: report?.recommendation ?? (response.ok
      ? "The researcher returned its findings as prose without filing a structured report."
      : "The upstream request failed. These are partial, unverified findings."),
    suggestedReads: (report?.suggested_reads ?? []).filter(page => observed.has(page.url)),
    sources: [...observed.values()],
    searchStats: policy.getStats(),
  };
}
