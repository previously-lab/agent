/**
 * Allowed path prefixes for agent file operations.
 * Agents may only read/write files under these directories.
 * src/ is agent-read-only — no tool may modify it.
 */
const ALLOWED_PATHS = ["memory/", "tasks/", "sessions/"] as const;

/**
 * Normalize a user-provided path to prevent traversal attacks.
 * - Decodes URI-encoded characters
 * - Converts Windows backslashes to forward slashes
 * - Resolves "." and ".." segments
 * - Strips leading slashes for prefix matching
 */
export function normalizePath(rawPath: string): string {
  // Decode URI components (e.g., %2F → /)
  let normalized = rawPath;
  try {
    normalized = decodeURIComponent(rawPath);
  } catch {
    // If decoding fails, use raw path — whitelist check will reject it
  }

  // Convert Windows backslashes to forward slashes
  normalized = normalized.replace(/\\/g, "/");

  // Resolve relative segments (./ ../)
  const segments = normalized.split("/");
  const resolved: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }

  return resolved.join("/");
}

/**
 * Check if a path is within the allowed directories.
 * Always normalize before checking — never trust raw input.
 */
export function isPathAllowed(rawPath: string): boolean {
  const normalized = normalizePath(rawPath);

  // Reject empty paths
  if (!normalized) {
    return false;
  }

  // Reject absolute paths (Unix and Windows)
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
    return false;
  }

  // Must match one of the allowed prefixes
  // Also check with trailing slash for bare directory names (e.g. "memory" → "memory/")
  return ALLOWED_PATHS.some(
    (prefix) => normalized.startsWith(prefix) || (normalized + "/").startsWith(prefix)
  );
}

/**
 * Get the list of allowed path prefixes.
 */
export function getAllowedPaths(): readonly string[] {
  return ALLOWED_PATHS;
}
