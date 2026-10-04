/**
 * Question run — the durable workflow entry (v0.19 §A.2.3-b).
 *
 * Fired by the scribe segment when a closed slice's mailbox carries
 * unanswered `question` markers (the question fact). NOT hung on the slice
 * close itself — the user asked, the research may run long. The doc-research
 * pass does the cross-slice digging and writes research/ hypotheses/ cases;
 * a tasks/ completion notice is what the next turn's reply segment states
 * (§A.3.3 — the run has no mouth).
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
