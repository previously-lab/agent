import { z } from "zod";

export const webSearchInputSchema = z.object({
  query: z.string().refine(query => query.trim().length > 0 && Array.from(query).length <= 128,
    "Search query must contain 1-128 Unicode characters and cannot be all whitespace.").describe("Focused public query, 1–128 Unicode characters. Search operators are preserved."),
  count: z.number().int().min(1).max(50).optional().describe("Number of results from DeepSeek, default 10."),
});

export const webFetchInputSchema = z.object({
  url: z.string().describe("Absolute public HTTP(S) URL to read."),
  range: z.object({
    type: z.enum(["search", "lines"]),
    keywords: z.array(z.string()).optional(),
    context: z.number().int().nonnegative().optional(),
    start: z.number().int().positive().optional(),
    end: z.number().int().positive().optional(),
  }).optional().describe("Select a 1-based inclusive line range or paragraphs matching keywords."),
  revision: z.string().optional().describe("For a continuation, copy the revision returned alongside the previous offset."),
  offset: z.number().int().nonnegative().optional().describe("Continue at the offset returned by the previous read of the same URL and range."),
});

export type WebFetchInput = z.infer<typeof webFetchInputSchema>;
