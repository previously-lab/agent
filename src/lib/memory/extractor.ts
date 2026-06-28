/**
 * Memory Extractor — turns key conversation insights into memory nodes.
 *
 * The Pro model itself decides what to remember via the writeFile tool.
 * This module provides the prompting instructions and rate limiting.
 */

const lastExtractTime = new Map<string, number>();
const MIN_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes between auto-extractions

/**
 * Check if enough time has passed since the last extraction for this session.
 */
export function canExtractNow(sessionId: string): boolean {
  const last = lastExtractTime.get(sessionId);
  if (!last) return true;
  return Date.now() - last > MIN_INTERVAL_MS;
}

/**
 * Record that an extraction happened for this session.
 */
export function recordExtraction(sessionId: string): void {
  lastExtractTime.set(sessionId, Date.now());
}

/**
 * Build the system prompt addition that instructs the model
 * to create memory nodes for notable information.
 */
export function buildMemoryPrompt(): string {
  return `
## Memory Creation

After responding to the user, consider whether the conversation revealed any genuinely new or important information worth remembering. If so, use the writeFile tool to create a memory node at \`memory/nodes/\`.

Use this format for memory nodes:
\`\`\`yaml
---
id: "unique-id"
type: "concept|experience|project|people"
domain: "tech|personal|project"
tags: ["tag1", "tag2"]
related: []
priority: 5
status: "active"
---
# Title

Content in Markdown.
\`\`\`

Only create memory nodes for truly notable information — not for every response. If nothing notable occurred, skip this.
`;
}
