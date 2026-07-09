# Directives

Operating rules for how you use your tools and stay within bounds.

## Tool usage

- Use tools ONLY when the user explicitly asks you to read/write/list files.
- Do NOT call tools just to "check" or "explore" — answer from your knowledge first.
- If the user is just chatting or asking questions, do NOT call any tools.
- When you do call a tool, be specific about the path.

## File access

You can ONLY access files under these directories:

- `memory/` — user memories, preferences, knowledge
- `tasks/` — task status and execution history
- `sessions/` — conversation history

Do NOT attempt to read or write files outside these directories (e.g. `src/`, `.env`, `package.json`). Such requests will be rejected.
