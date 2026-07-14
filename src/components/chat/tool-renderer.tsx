"use client";

import { extractRenderState } from "@/lib/chat/tool-state";
import { useTranslations } from "next-intl";
import { ReadFileRenderer } from "./tool-renderers/read-file";
import { WriteFileRenderer } from "./tool-renderers/write-file";
import { ListFilesRenderer } from "./tool-renderers/list-files";
import { MemoryToolRenderer } from "./tool-renderers/memory-tool";
import { LoopToolRenderer } from "./tool-renderers/loop";
import { DefaultRenderer } from "./tool-renderers/default";

interface ToolRendererProps {
  toolName: string;
  state: string;
  input?: unknown;
  output?: unknown;
  isStreaming: boolean;
}

/** Human-friendly outer labels — the user sees these, not raw tool names. */
function friendlyName(
  toolName: string,
  t: ReturnType<typeof useTranslations>,
): string {
  switch (toolName) {
    case "readMemory":
      return t("readMemory");
    case "listMemory":
      return t("listMemory");
    case "readIndex":
      return t("readIndex");
    case "writeMemory":
      return t("writeMemory");
    case "updateUserProfile":
      return t("updateUserProfile");
    case "startLoop":
      return t("startLoop");
    default:
      return toolName.charAt(0).toUpperCase() + toolName.slice(1);
  }
}

export function ToolRenderer({ toolName, state, input, output, isStreaming }: ToolRendererProps) {
  const t = useTranslations("chat.tool");
  const renderState = extractRenderState({ state }, null, isStreaming);
  const displayName = friendlyName(toolName, t);

  switch (toolName) {
    case "readFile":
      return (
        <ReadFileRenderer
          input={input as { path?: string } | undefined}
          output={typeof output === "string" ? output : undefined}
          state={renderState}
        />
      );
    case "writeFile":
      return (
        <WriteFileRenderer
          input={input as { path?: string; content?: string } | undefined}
          output={typeof output === "string" ? output : undefined}
          state={renderState}
        />
      );
    case "writeMemory":
      return (
        <WriteFileRenderer
          input={input as { path?: string; content?: string } | undefined}
          output={typeof output === "string" ? output : undefined}
          state={renderState}
        />
      );
    case "listFiles":
      return (
        <ListFilesRenderer
          input={input as { path?: string } | undefined}
          output={output as Array<{ name: string; type: string }> | undefined}
          state={renderState}
        />
      );
    case "readMemory":
    case "listMemory":
    case "readIndex":
      return (
        <MemoryToolRenderer
          toolName={toolName}
          displayName={displayName}
          input={input}
          output={output}
          state={renderState}
        />
      );
    case "startLoop":
      return (
        <LoopToolRenderer
          input={input as { goal?: string; tags?: string[] } | undefined}
          output={
            output as
              | { ok?: boolean; loopId?: string; filePath?: string; error?: string }
              | undefined
          }
          state={renderState}
        />
      );
    default:
      return (
        <DefaultRenderer
          toolName={displayName}
          input={input}
          state={renderState}
        />
      );
  }
}

export { ToolLayout } from "./tool-layout";
export type { ToolLayoutProps } from "./tool-layout";
