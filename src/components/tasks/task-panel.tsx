"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale } from "next-intl";
import { BookOpen, ListTodo, RefreshCw, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useShell } from "@/components/shell/shell-provider";
import { GAME_SIM_FREEZE } from "@/components/game/sim-freeze";
import { WORLD_TRANSITION } from "@/lib/timeline3d/world-transition";
import { getTaskPanelPage } from "@/lib/tasks/panel-action";
import {
  TASK_PANEL_FILTERS,
  type TaskPanelFilter,
  type TaskPanelItem,
} from "@/lib/tasks/panel";
import {
  applyPanelResponse,
  beginPanelRequest,
  failPanelRequest,
  initialTaskPanelUiState,
  panelNextOffset,
  simulationFreezeAfterTaskPanel,
  taskPanelKeyDisposition,
} from "./task-panel-state";
import type { TaskPanelEventHandler } from "./events";
import { taskPanelStrings } from "./strings";
import "./task-panel.css";

function updatedLabel(value: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function TaskPanel({ onEvent }: { onEvent?: TaskPanelEventHandler }) {
  const locale = useLocale();
  const strings = taskPanelStrings(locale);
  const { openDesk } = useShell();
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  const requestIdRef = useRef(0);
  const [ui, setUi] = useState(initialTaskPanelUiState);

  const load = useCallback(
    async (
      filter: TaskPanelFilter,
      offset: number,
      reset: boolean,
      refresh: boolean,
      snapshot?: string,
    ) => {
      const requestId = ++requestIdRef.current;
      setUi((previous) => ({
        ...beginPanelRequest(previous, filter, reset),
        requestId,
      }));
      try {
        const response = await getTaskPanelPage({
          filter,
          offset,
          refresh,
          ...(snapshot ? { snapshot } : {}),
        });
        setUi((previous) => applyPanelResponse(previous, requestId, response) ?? previous);
      } catch {
        setUi((previous) => failPanelRequest(previous, requestId) ?? previous);
      }
    },
    [],
  );

  const openPanel = useCallback(() => {
    if (openRef.current) return;
    openRef.current = true;
    setOpen(true);
    onEvent?.({ type: "panel_opened", reason: "toggle" });
    void load("active", 0, true, true);
  }, [load, onEvent]);

  const closePanel = useCallback(
    (reason: "close_button" | "escape" | "dismiss" | "selection") => {
      if (!openRef.current) return;
      openRef.current = false;
      requestIdRef.current += 1;
      setOpen(false);
      setUi(initialTaskPanelUiState());
      onEvent?.({ type: "panel_closed", reason });
    },
    [onEvent],
  );

  useEffect(() => {
    if (!open) return;
    const previousFreeze = GAME_SIM_FREEZE.frozen;
    GAME_SIM_FREEZE.frozen = true;
    return () => {
      GAME_SIM_FREEZE.frozen = simulationFreezeAfterTaskPanel(
        previousFreeze,
        WORLD_TRANSITION.active,
      );
    };
  }, [open]);

  useEffect(() => {
    return () => {
      requestIdRef.current += 1;
    };
  }, []);

  const selectTask = useCallback(
    (task: TaskPanelItem) => {
      onEvent?.({ type: "task_selected", ref: task.ref });
      openDesk(task.ref, "manual");
      closePanel("selection");
    },
    [closePanel, onEvent, openDesk],
  );

  const selectEvidence = useCallback(
    (task: TaskPanelItem, docRef: string, turnId: string) => {
      onEvent?.({ type: "evidence_selected", taskRef: task.ref, docRef, turnId });
      openDesk(docRef, "manual");
      closePanel("selection");
    },
    [closePanel, onEvent, openDesk],
  );

  const response = ui.response;
  const nextOffset = panelNextOffset(ui);

  return (
    <div className="task-panel-control">
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (nextOpen) openPanel();
          else closePanel("dismiss");
        }}
      >
        <DialogTrigger
          data-task-panel-toggle
          aria-label={strings.toggleLabel}
          title={strings.toggleLabel}
          className="task-panel-toggle chrome-island"
        >
          <ListTodo className="size-4" aria-hidden="true" />
        </DialogTrigger>
        <DialogContent
          showCloseButton={false}
          overlayClassName="z-[60]"
          className="task-panel-content z-[61] sm:max-w-2xl"
          onKeyDownCapture={(event) => {
            if (taskPanelKeyDisposition(event.key) !== "close") return;
            event.preventDefault();
            event.stopPropagation();
            closePanel("escape");
          }}
          onKeyDown={(event) => {
            if (taskPanelKeyDisposition(event.key) === "stop-world") {
              event.stopPropagation();
            }
          }}
        >
          <DialogHeader className="task-panel-header">
            <div>
              <DialogTitle className="task-panel-heading">{strings.title}</DialogTitle>
              <DialogDescription className="task-panel-description">
                {strings.description}
              </DialogDescription>
            </div>
            <div className="task-panel-header-actions">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="task-icon-button"
                aria-label={strings.refresh}
                title={strings.refresh}
                disabled={ui.loading}
                onClick={() => void load(ui.filter, 0, true, true)}
              >
                <RefreshCw aria-hidden="true" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="task-icon-button"
                aria-label={strings.close}
                title={strings.close}
                onClick={() => closePanel("close_button")}
              >
                <X aria-hidden="true" />
              </Button>
            </div>
          </DialogHeader>

          <div className="task-panel-filters" role="group" aria-label={strings.filterLabel}>
            {TASK_PANEL_FILTERS.map((filter) => (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                key={filter}
                data-task-filter={filter}
                aria-pressed={ui.filter === filter}
                disabled={ui.loading}
                onClick={() => void load(filter, 0, true, false)}
              >
                {strings.filters[filter]}
                {response?.status === "ready" && (
                  <span className="task-filter-count">{response.counts[filter]}</span>
                )}
              </Button>
            ))}
          </div>

          <div className="task-panel-scroll" aria-busy={ui.loading}>
            {ui.loading && response === null && (
              <p className="task-panel-state" role="status">{strings.loading}</p>
            )}
            {ui.requestFailed && response === null && (
              <div className="task-panel-state" role="alert">
                <h3>{strings.requestFailedTitle}</h3>
                <p>{strings.requestFailedBody}</p>
                <Button type="button" variant="outline" onClick={() => void load(ui.filter, 0, true, true)}>
                  {strings.retry}
                </Button>
              </div>
            )}
            {response?.status === "missing" && (
              <div className="task-panel-state">
                <h3>{strings.missingTitle}</h3>
                <p>{strings.missingBody}</p>
              </div>
            )}
            {response?.status === "corrupt" && (
              <div className="task-panel-state" role="alert">
                <h3>{strings.corruptTitle}</h3>
                <p>{strings.corruptBody}</p>
              </div>
            )}
            {response?.status === "unavailable" && (
              <div className="task-panel-state" role="alert">
                <h3>{strings.unavailableTitle}</h3>
                <p>{strings.unavailableBody}</p>
              </div>
            )}
            {response?.status === "stale" && (
              <div className="task-panel-state" role="alert">
                <h3>{strings.staleTitle}</h3>
                <p>{strings.staleBody}</p>
                <Button type="button" variant="outline" onClick={() => void load(ui.filter, 0, true, false)}>
                  {strings.retry}
                </Button>
              </div>
            )}
            {response?.status === "ready" && (
              <>
                {ui.items.length === 0 && !ui.loading ? (
                  <p className="task-panel-state">{strings.empty}</p>
                ) : (
                  <ol className="task-list" aria-label={strings.taskListLabel}>
                    {ui.items.map((task) => (
                      <li key={task.ref} className="task-item" data-task-status={task.status}>
                        <div className="task-item-heading">
                          <div>
                            <span className="task-status">{strings.status[task.status]}</span>
                            <h3>{task.summary}</h3>
                          </div>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="task-action"
                            onClick={() => selectTask(task)}
                          >
                            <BookOpen aria-hidden="true" />
                            {strings.openManuscript}
                          </Button>
                        </div>
                        <dl className="task-facts">
                          {task.dueOn && <div><dt>{strings.dueLabel}</dt><dd>{task.dueOn}</dd></div>}
                          {task.nextCheckOn && <div><dt>{strings.nextCheckLabel}</dt><dd>{task.nextCheckOn}</dd></div>}
                          <div><dt>{strings.updatedLabel}</dt><dd>{updatedLabel(task.updatedAt, locale)}</dd></div>
                        </dl>
                        {task.waitingCondition && (
                          <p className="task-next"><strong>{strings.waitingOnLabel}</strong>{task.waitingCondition}</p>
                        )}
                        {task.nextAction && (
                          <p className="task-next"><strong>{strings.nextActionLabel}</strong>{task.nextAction}</p>
                        )}
                        {task.pendingResults.length > 0 && (
                          <section className="task-results" aria-label={strings.pendingResultsHeading}>
                            <h4>{strings.pendingResultsHeading}</h4>
                            {task.pendingResults.map((result) => (
                              <div key={result.id} className="task-result">
                                <span>{strings.resultPendingBadge}</span>
                                <p>{result.statement}</p>
                              </div>
                            ))}
                          </section>
                        )}
                        {task.evidence.length > 0 && (
                          <section className="task-evidence" aria-label={strings.evidenceHeading}>
                            <h4>{strings.evidenceHeading}</h4>
                            {task.evidence.map((evidence) => (
                              <div key={`${evidence.sliceId}:${evidence.turnId}`} className="task-evidence-item">
                                <p>{evidence.statement}</p>
                                {evidence.docRef && (
                                  <Button
                                    type="button"
                                    variant="link"
                                    size="sm"
                                    className="task-action"
                                    onClick={() => selectEvidence(task, evidence.docRef!, evidence.turnId)}
                                  >
                                    {strings.sourceButton}
                                  </Button>
                                )}
                              </div>
                            ))}
                          </section>
                        )}
                      </li>
                    ))}
                  </ol>
                )}
                <div className="task-panel-pagination">
                  <span>{strings.shownOf(ui.items.length, response.total)}</span>
                  {nextOffset !== null && (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={ui.loading}
                      onClick={() => void load(ui.filter, nextOffset, false, false, response.snapshot)}
                    >
                      {strings.loadMore}
                    </Button>
                  )}
                </div>
                {ui.requestFailed && (
                  <div className="task-panel-state" role="alert">
                    <p>{strings.requestFailedBody}</p>
                    <Button type="button" variant="outline" onClick={() => void load(ui.filter, 0, true, true)}>
                      {strings.retry}
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
