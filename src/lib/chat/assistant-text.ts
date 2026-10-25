import type { UIMessage } from "./protocol";

export function visibleAssistantText(message: UIMessage): string {
  const rounds: string[] = [];
  let current = "";
  const flush = (): void => {
    if (current.trim()) rounds.push(current);
    current = "";
  };
  for (const part of message.parts) {
    if (part.type === "text") {
      current += part.text;
    } else if (part.type === "step-start" || part.type === "data-deepseek-step") {
      flush();
    }
  }
  flush();
  return rounds.join("\n\n");
}

export function nativeMessageTurnId(message: UIMessage): string {
  const metadata = message.metadata as { recoveryTurnId?: unknown } | undefined;
  if (typeof metadata?.recoveryTurnId === "string" && metadata.recoveryTurnId) {
    return metadata.recoveryTurnId;
  }
  for (let index = message.parts.length - 1; index >= 0; index--) {
    const part = message.parts[index];
    if (part.type !== "data-turn-status") continue;
    const data = part.data as { turnId?: unknown };
    if (typeof data.turnId === "string" && data.turnId) return data.turnId;
  }
  return message.id;
}

export function nativeMessageTurnIdentity(message: UIMessage): {
  turnId: string;
  provisionalTurnId?: string;
} {
  const metadata = message.metadata as { recoveryTurnId?: unknown } | undefined;
  if (typeof metadata?.recoveryTurnId === "string" && metadata.recoveryTurnId) {
    return { turnId: metadata.recoveryTurnId };
  }
  for (let index = message.parts.length - 1; index >= 0; index--) {
    const part = message.parts[index];
    if (part.type !== "data-turn-status") continue;
    const data = part.data as { status?: unknown; turnId?: unknown };
    if (data.status !== "done" && data.status !== "interrupted" && data.status !== "error") continue;
    if (typeof data.turnId === "string" && data.turnId) {
      return {
        turnId: data.turnId,
        ...(data.turnId === message.id ? {} : { provisionalTurnId: message.id }),
      };
    }
  }
  return { turnId: message.id };
}
