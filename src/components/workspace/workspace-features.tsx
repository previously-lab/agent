"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { usePathname } from "@/i18n/navigation";
import { useReducedMotion } from "motion/react";
import { useTranslations } from "next-intl";
import { Sparkles } from "lucide-react";
import { toast } from "sonner";
import {
  applyEvolutionActivity,
  EVOLUTION_PRESENCE_IDLE,
  EvolutionToastDedupe,
  evolutionToastContent,
  subscribeEvolutionActivity,
} from "@/lib/chat/evolution-activity";
import {
  CompanionPod,
  type NarrationTarget,
} from "@/components/companion/companion-pod";
import { TaskPanel } from "@/components/tasks/task-panel";
import type { TaskPanelEvent } from "@/components/tasks/events";
import { useNativeSourceScope } from "@/components/chat/native-source-scope";
import { useShell } from "@/components/shell/shell-provider";

export function WorkspaceFeatures() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const sourceScope = useNativeSourceScope();
  const persona = searchParams.get("persona") ?? "user";
  const lane = JSON.stringify([sourceScope, persona]);
  const { screen } = useShell();
  const reducedMotion = useReducedMotion() ?? false;
  const tCompanion = useTranslations("companion");
  const [narrateTarget, setNarrateTarget] = useState<NarrationTarget | null>(null);
  const narrateGenRef = useRef(0);
  const startNarration = useCallback((sliceId: string, timeLabel?: string) => {
    narrateGenRef.current += 1;
    setNarrateTarget({ sliceId, timeLabel, gen: narrateGenRef.current });
  }, []);
  const [evolution, setEvolution] = useState(EVOLUTION_PRESENCE_IDLE);
  const evolutionToastDedupe = useRef(new EvolutionToastDedupe());

  useEffect(() => subscribeEvolutionActivity((event) => {
    setEvolution((previous) => applyEvolutionActivity(previous, event));
    if (event.kind !== "done") return;
    const content = evolutionToastContent(event, {
      title: tCompanion("evolvedToast"),
      fallback: tCompanion("evolvedFallback"),
    });
    if (content && evolutionToastDedupe.current.markToasted(event.turnId)) {
      toast(content.title, {
        description: content.description,
        icon: <Sparkles className="size-4" />,
      });
    }
  }), [tCompanion]);

  const onTaskPanelEvent = useCallback((event: TaskPanelEvent) => {
    if (event.type === "panel_opened") screen.taskPanelViewed();
    else if (event.type === "panel_closed") screen.taskPanelClosed();
    else if (event.type === "task_selected") screen.taskSelected({ ref: event.ref });
  }, [screen]);

  if (pathname !== "/app" && pathname !== "/game") return null;
  return (
    <div data-workspace-features className="workspace-features">
      <TaskPanel key={lane} onEvent={onTaskPanelEvent} />
      <CompanionPod
        target={narrateTarget}
        onDismiss={() => setNarrateTarget(null)}
        onRetry={startNarration}
        reducedMotion={reducedMotion}
        working={evolution.working}
        evolution={evolution}
      />
    </div>
  );
}
