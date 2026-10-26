/**
 * The task panel's user-event vocabulary (v0.11 streams). Optional callback:
 * the connected TaskPanel emits these for ACTUAL user gestures only — panel
 * opened/closed (with reason), a task manuscript selected, an evidence
 * source selected. Screen-coordinator wiring observes these. The panel owns
 * openDesk for those selections and a reversible simulation pause while open;
 * callbacks must not duplicate navigation or mutate the ledger.
 */

export type TaskPanelEvent =
  | { type: "panel_opened"; reason: "toggle" }
  | {
      type: "panel_closed";
      reason: "close_button" | "escape" | "dismiss" | "selection";
    }
  /** The reader asked for the task's manuscript (openDesk(task.ref)). */
  | { type: "task_selected"; ref: string }
  /** The reader asked for one evidence source (openDesk(records/<sliceId>)). */
  | {
      type: "evidence_selected";
      taskRef: string;
      docRef: string;
      turnId: string;
    };

export type TaskPanelEventHandler = (event: TaskPanelEvent) => void;
