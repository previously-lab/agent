/**
 * HQ contract — what both sides of the field↔HQ channel share (v0.21 §4).
 *
 * Pure by construction: one token constant and two payload/outcome types.
 * `hq-run.ts` is a WORKFLOW file, and the Workflow SDK bundles a workflow
 * file's static import graph into the sandbox — which has no Node modules
 * (docs/errors/node-js-module-in-workflow). So this module must stay free of
 * imports; anything impure belongs in `hq-steps.ts` behind "use step".
 */

/**
 * The one global HQ hook token (§4 裁决 9: globally unique, need not be
 * hard-guaranteed — a re-start simply claims it again).
 */
export const HQ_TOKEN = "hq:main";

/** One field report: prose + the mechanically-attached return address. */
export interface HQBriefPayload {
  /**
   * 散文简报：现场描述 + 外勤自己的观察。不含期待、不含指令、不做模板
   * （§4 裁决 10）——载荷本质就是 prompt，语义化的 prompt。
   */
  brief: string;
  /**
   * 机械层自动附带（模型不写它）：`field:<sliceId>:<startedAtIso>`——
   * 对话轮 run 收尾那一拍用同一个 token 建回调 hook（turn-workflow.ts）。
   */
  replyToken: string;
}

export type HQRunOutcome =
  | { kind: "claimed"; handled: number }
  | { kind: "dedupedTo"; runId: string };
