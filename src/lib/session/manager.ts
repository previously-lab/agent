export interface Turn {
  role: "user" | "assistant";
  content: string;
  action?: string;
  linkedMemory?: string;
}

export interface SessionSummary {
  goal: string;
  attempted: string[];
  current_blocker: string;
}

export interface SessionState {
  sessionId: string;
  currentIntent: string;
  recentTurns: Turn[];
  accumulatedSummary: SessionSummary;
  linkedMemories: string[];
  startTime: string;
  status: "running" | "done";
}

const MAX_TURNS = 5;
const sessions = new Map<string, SessionState>();

/**
 * Get or create a session.
 */
export function getSession(sessionId: string): SessionState {
  let session = sessions.get(sessionId);
  if (!session) {
    session = {
      sessionId,
      currentIntent: "clarify",
      recentTurns: [],
      accumulatedSummary: { goal: "", attempted: [], current_blocker: "" },
      linkedMemories: [],
      startTime: new Date().toISOString(),
      status: "running",
    };
    sessions.set(sessionId, session);
  }
  return session;
}

/**
 * Append a turn and apply rule-based summary extraction.
 */
export function updateTurn(sessionId: string, turn: Turn): SessionState {
  const session = getSession(sessionId);

  // Append turn
  session.recentTurns.push(turn);

  // Sliding window: keep only last MAX_TURNS
  if (session.recentTurns.length > MAX_TURNS) {
    session.recentTurns = session.recentTurns.slice(-MAX_TURNS);
  }

  // Rule-based summary extraction
  if (turn.role === "assistant") {
    if (turn.action === "analyzed") {
      session.accumulatedSummary.attempted.push(
        turn.content.slice(0, 100)
      );
    }
    if (turn.linkedMemory?.startsWith("memory")) {
      // could be a node ID — track it
      // Tracking memory: use the raw ID
    }
  }

  if (turn.role === "user") {
    session.linkedMemories.push(
      ...extractMemoryRefs(turn.content)
    );
  }

  // Update blocker
  const blockerMatch = turn.content.match(
    /blocker|阻挡|卡住|问题.*是|error[:\s]+([^\n]+)/i
  );
  if (blockerMatch) {
    session.accumulatedSummary.current_blocker =
      blockerMatch[1] || turn.content.slice(0, 100);
  }

  return session;
}

/**
 * Extract memory node references from text.
 */
function extractMemoryRefs(text: string): string[] {
  const refs: string[] = [];
  const pattern = /\[\[([a-zA-Z0-9_-]+)\]\]/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    refs.push(match[1]);
  }
  return refs;
}

/**
 * Set the session intent (called after router classification).
 */
export function setIntent(sessionId: string, intent: string): void {
  const session = getSession(sessionId);
  session.currentIntent = intent;
}

/**
 * End a session and return its serializable state.
 */
export function endSession(sessionId: string): SessionState {
  const session = getSession(sessionId);
  session.status = "done";
  return session;
}

/**
 * Clear session from memory (for testing).
 */
export function clearSession(sessionId: string): void {
  sessions.delete(sessionId);
}

/**
 * Clear all sessions (for testing).
 */
export function clearAllSessions(): void {
  sessions.clear();
}
