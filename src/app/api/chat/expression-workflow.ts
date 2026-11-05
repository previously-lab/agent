import { acquireExpressionStep, expressionRoundStep, publishExpressionSegmentStep, settleExpressionPlanStep, releaseExpressionStep } from "./dialogue-steps";
import { ownRunId } from "./steps";

export async function expressionWorkflow(scopeKey: string): Promise<void> {
  "use workflow";
  const runId = await ownRunId();
  const fence = await acquireExpressionStep(scopeKey, runId);
  if (!fence) return;
  for (let lap = 0; lap < 4; lap++) {
    const round = await expressionRoundStep(scopeKey, fence, runId);
    if (!round) break;
    const { saved, observedWake } = round;
    if (saved) {
      let publicHighWater = saved.basis.publicHighWater;
      let defer = true;
      for (let i = 0; i < saved.plan.sends.length; i++) {
        const step = await publishExpressionSegmentStep(scopeKey, fence, saved, i, publicHighWater);
        if (step.status !== "committed") {
          defer = step.status === "invalid";
          break;
        }
        publicHighWater = step.utterances[0]?.publicSeq ?? publicHighWater;
      }
      await settleExpressionPlanStep(scopeKey, fence, saved.id, defer);
    }
    const state = await releaseExpressionStep(scopeKey, fence, observedWake, lap === 3);
    if (state !== "continue") return;
  }
}
