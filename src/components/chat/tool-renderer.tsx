"use client";

import { extractRenderState } from "@/lib/chat/tool-state";
import { ReadFileRenderer } from "./tool-renderers/read-file";
import { WriteFileRenderer } from "./tool-renderers/write-file";
import { ListFilesRenderer } from "./tool-renderers/list-files";
import { DefaultRenderer } from "./tool-renderers/default";

interface ToolRendererProps {
  toolName: string;
  state: string;
  input?: unknown;
  output?: unknown;
  isStreaming: boolean;
}

export function ToolRenderer({ toolName, state, input, output, isStreaming }: ToolRendererProps) {
  const renderState = extractRenderState({ state }, null, isStreaming);

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
    case "listFiles":
      return (
        <ListFilesRenderer
          input={input as { path?: string } | undefined}
          output={output as Array<{ name: string; type: string }> | undefined}
          state={renderState}
        />
      );
    default:
      return (
        <DefaultRenderer
          toolName={toolName}
          input={input}
          state={renderState}
        />
      );
  }
}

export { ToolLayout } from "./tool-layout";
export type { ToolLayoutProps } from "./tool-layout";
