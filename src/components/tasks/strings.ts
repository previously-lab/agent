/**
 * The task panel's LOCAL bilingual strings (v0.11 streams). A small module
 * keyed by the active locale — deliberately NOT the shared i18n JSON, which
 * the task-panel lane does not own.
 */

export type TaskPanelLocale = "en" | "zh";

const EN = {
  toggleLabel: "Tasks",
  title: "Tasks",
  description: "Things to follow up on, and what comes next.",
  close: "Close",
  refresh: "Refresh",
  loading: "Loading tasks…",
  empty: "No tasks in this view.",
  missingTitle: "Task tracking has not started yet",
  missingBody:
    "Discuss something you want to follow up on with Previously to start tracking it here.",
  corruptTitle: "Tasks could not be read",
  corruptBody: "The saved task information needs to be repaired before it can be shown.",
  unavailableTitle: "Tasks are temporarily unavailable",
  unavailableBody: "Please try again in a moment.",
  staleTitle: "Tasks have changed",
  staleBody: "Refresh to see their latest status.",
  requestFailedTitle: "Tasks could not be loaded",
  requestFailedBody: "Please try again in a moment.",
  retry: "Retry",
  filterLabel: "Filter tasks",
  taskListLabel: "Tasks",
  filters: {
    active: "Active",
    waiting: "Waiting",
    paused: "Paused",
    finished: "Finished",
    all: "All",
  } as Record<string, string>,
  status: {
    open: "Active",
    waiting: "Waiting",
    paused: "Paused",
    completed: "Completed",
    cancelled: "Cancelled",
    needs_review: "Needs review",
  } as Record<string, string>,
  needsReviewBadge: "Needs review",
  dueLabel: "Due",
  nextCheckLabel: "Next check",
  waitingOnLabel: "Waiting on",
  nextActionLabel: "Next action",
  updatedLabel: "Updated",
  openManuscript: "Read document",
  evidenceHeading: "Sources",
  sourceButton: "Original conversation",
  pendingResultsHeading: "New progress",
  resultPendingBadge: "Ready to share",
  loadMore: "Load more",
  shownOf: (shown: number, total: number) => `${shown} of ${total} tasks`,
};

const ZH: typeof EN = {
  toggleLabel: "任务",
  title: "任务",
  description: "记录仍在继续的事情，以及下一步。",
  close: "关闭",
  refresh: "刷新",
  loading: "正在读取任务…",
  empty: "此视图暂无任务。",
  missingTitle: "还没有开始记录任务",
  missingBody: "和 Previously 聊聊想要跟进的事情，就可以在这里持续关注。",
  corruptTitle: "任务信息无法读取",
  corruptBody: "已保存的任务信息需要修复，暂时无法显示。",
  unavailableTitle: "任务暂时不可用",
  unavailableBody: "请稍后重试。",
  staleTitle: "任务已有更新",
  staleBody: "刷新后查看最新状态。",
  requestFailedTitle: "任务加载失败",
  requestFailedBody: "请稍后重试。",
  retry: "重试",
  filterLabel: "筛选任务",
  taskListLabel: "任务列表",
  filters: {
    active: "进行中",
    waiting: "等待中",
    paused: "已暂停",
    finished: "已结束",
    all: "全部",
  },
  status: {
    open: "进行中",
    waiting: "等待中",
    paused: "已暂停",
    completed: "已完成",
    cancelled: "已取消",
    needs_review: "待确认",
  },
  needsReviewBadge: "待确认",
  dueLabel: "截止",
  nextCheckLabel: "下次跟进",
  waitingOnLabel: "等待条件",
  nextActionLabel: "下一步",
  updatedLabel: "更新于",
  openManuscript: "打开文档",
  evidenceHeading: "来源",
  sourceButton: "原始对话",
  pendingResultsHeading: "新进展",
  resultPendingBadge: "待与你分享",
  loadMore: "加载更多",
  shownOf: (shown, total) => `已显示 ${shown} / ${total} 项`,
};

export type TaskPanelStrings = typeof EN;

export function taskPanelStrings(locale: string): TaskPanelStrings {
  return locale === "zh" ? ZH : EN;
}
