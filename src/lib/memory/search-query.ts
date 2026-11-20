import { z } from "zod";

const keyword = z.string().trim().min(1).max(256);

/** Some providers encode a keyword array as a JSON string inside the tool arguments. */
export const recallSearchQuerySchema = z.preprocess((query) => {
  if (typeof query !== "string" || !query.trimStart().startsWith("[")) return query;
  try {
    const decoded: unknown = JSON.parse(query);
    if (Array.isArray(decoded) && decoded.every(term => typeof term === "string")) return decoded;
  } catch {
    // A bracketed literal is still a valid single keyword.
  }
  return query;
}, z.union([keyword, z.array(keyword).min(1).max(8)]));
