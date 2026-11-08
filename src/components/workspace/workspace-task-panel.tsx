"use client";

import { useCallback } from "react";
import { TaskPanel } from "@/components/tasks/task-panel";
import type { TaskPanelEvent } from "@/components/tasks/events";
import { useShell } from "@/components/shell/shell-provider";

export function WorkspaceTaskPanel() {
  const { screen } = useShell();
  const onEvent = useCallback((event: TaskPanelEvent) => {
    if (event.type === "panel_opened") screen.taskPanelViewed();
    else if (event.type === "panel_closed") screen.taskPanelClosed();
    else if (event.type === "task_selected") screen.taskSelected({ ref: event.ref });
  }, [screen]);
  return <TaskPanel onEvent={onEvent} />;
}
