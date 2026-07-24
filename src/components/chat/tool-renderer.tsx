"use client";

import { extractRenderState } from "@/lib/chat/tool-state";
import { useTranslations } from "next-intl";
import { ListFilesRenderer } from "./tool-renderers/list-files";
import { MemoryToolRenderer } from "./tool-renderers/memory-tool";
import { RecallToolRenderer } from "./tool-renderers/recall";
import { WebSearchRenderer } from "./tool-renderers/web-search";
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
    case "readSlice":
      return t("readSlice");
    case "listSlices":
      return t("listSlices");
    case "readTimeline":
      return t("readTimeline");
    case "readStrand":
      return t("readStrand");
    case "listStrands":
      return t("listStrands");
    case "readAgentTimeline":
      return t("readAgentTimeline");
    case "readPreviously":
      return t("readPreviously");
    case "webSearch":
      return t("webSearch");
    case "startLoop":
      return t("startLoop");
    case "recall":
      return t("recall");
    case "updateSliceMeta":
      return t("updateSliceMeta");
    case "updatePreviously":
      return t("updatePreviously");
    default:
      return toolName.charAt(0).toUpperCase() + toolName.slice(1);
  }
}

/** Dynamic streaming/done labels in Chinese for the unified stream.
 *  "回忆" is reserved for Flash only. Tools use "查看" / "查找". */
function toolLabel(toolName: string, running: boolean): string {
  if (running) {
    switch (toolName) {
      case "readSlice":         return "正在查看时间片…";
      case "listSlices":        return "正在查找更多…";
      case "readTimeline":      return "正在查看时间线…";
      case "readStrand":        return "正在查找线索…";
      case "listStrands":       return "正在列出线索…";
      case "readAgentTimeline": return "正在查看思考过程…";
      case "readPreviously":    return "正在查看前情提要…";
      case "recall":           return "正在回忆…";
      case "webSearch":         return "正在搜索网络…";
      case "startLoop":         return "正在启动后台任务…";
      case "updateSliceMeta":   return "正在更新切片信息…";
      case "updatePreviously":  return "正在更新前情提要…";
      default:                  return `正在调用 ${toolName}…`;
    }
  }
  switch (toolName) {
    case "readSlice":         return "已查看时间片";
    case "listSlices":        return "已查找";
    case "readTimeline":      return "已查看时间线";
    case "readStrand":        return "已查找线索";
    case "listStrands":       return "已列出线索";
    case "readAgentTimeline": return "已查看思考过程";
    case "readPreviously":    return "已查看前情提要";
    case "recall":           return "回忆完成";
    case "webSearch":         return "搜索完成";
    case "startLoop":         return "已启动后台任务";
    case "updateSliceMeta":   return "已更新切片信息";
    case "updatePreviously":  return "已更新前情提要";
    default:                  return `${toolName} 完成`;
  }
}

export function ToolRenderer({ toolName, state, input, output, isStreaming }: ToolRendererProps) {
  const t = useTranslations("chat.tool");
  const renderState = extractRenderState({ state }, null, isStreaming);
  const displayName = friendlyName(toolName, t);

  switch (toolName) {
    case "readSlice":
    case "readAgentTimeline":
    case "readPreviously":
      return (
        <MemoryToolRenderer
          toolName={toolName}
          displayName={displayName}
          input={input}
          output={output}
          state={renderState}
        />
      );
    case "listSlices":
    case "listStrands":
      return (
        <ListFilesRenderer
          displayName={displayName}
          input={input as { path?: string } | undefined}
          output={output as Array<{ name: string; type: string }> | undefined}
          state={renderState}
        />
      );
    case "readTimeline":
    case "readStrand":
      return (
        <MemoryToolRenderer
          toolName={toolName}
          displayName={displayName}
          input={input}
          output={output}
          state={renderState}
        />
      );
    case "webSearch":
      return (
        <WebSearchRenderer
          displayName={displayName}
          input={input}
          output={output}
          state={renderState}
        />
      );
    case "recall":
      return (
        <RecallToolRenderer
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
