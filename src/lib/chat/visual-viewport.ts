export interface ConversationViewport {
  width: number;
  height: number;
  offsetLeft: number;
  offsetTop: number;
}

/** Browser measurements only; spacing and safe-area remain CSS tokens. */
export function conversationViewportInsets(width: number, height: number, viewport?: ConversationViewport) {
  if (!viewport || ![width, height, viewport.width, viewport.height, viewport.offsetLeft, viewport.offsetTop].every(Number.isFinite)) {
    return { right: 0, bottom: 0, height };
  }
  return {
    right: Math.max(0, width - viewport.width - viewport.offsetLeft),
    bottom: Math.max(0, height - viewport.height - viewport.offsetTop),
    height: Math.max(0, viewport.height),
  };
}
