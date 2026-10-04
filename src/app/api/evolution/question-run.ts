/**
 * Question run — the durable workflow entry for the conversation's
 * SUB-STREAM (v0.21 §2; formerly v0.19 §A.2.3-b).
 *
 * Trigger: the field's `startLongTask` tool, fired ON THE SPOT when the user
 * explicitly asks for long work ("去查一下 X") — the tool drops the question
 * marker into the LIVE slice's mailbox, then starts this run
 * fire-and-forget. (The old slice-close marker-scan route is retired by the
 * P4 lane; the mailbox marker contract itself is frozen and unchanged —
 * the doc-research pass still takes its whole agenda from the markers.)
 * The pass does the cross-slice digging and writes research/ hypotheses/
 * cases; a tasks/ completion notice is what a later turn's reply segment
 * reads and states (§A.3.3 — the run has no mouth).
 *
 * Lives under src/app so the `withWorkflow` loader picks up the directive.
 */
import {
  executeQuestionRun,
  type QuestionRunInput,
} from "./background-steps";

export async function questionRun(input: QuestionRunInput): Promise<void> {
  "use workflow";
  await executeQuestionRun(input);
}
