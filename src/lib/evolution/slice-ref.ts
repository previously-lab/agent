const SCENARIO_ID_RE = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})$/;
const SLICE_REF_RE = /^(\d{4}-\d{2}-\d{2}-\d{4})(?:-[0-9a-z_-]{4,})?$/i;

export function isCanonicalScenarioId(value: string): boolean {
  const match = value.match(SCENARIO_ID_RE);
  if (!match) return false;
  const [, year, month, day, hourText, minuteText] = match;
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (hour > 23 || minute > 59) return false;
  const instant = new Date(`${year}-${month}-${day}T${hourText}:${minuteText}:00.000Z`);
  return !Number.isNaN(instant.getTime()) && instant.toISOString().slice(0, 10) === `${year}-${month}-${day}`;
}

/** Return the scenario portion of a canonical slice or slice-turn pointer. */
export function canonicalScenarioFromRef(ref: string): string | null {
  const match = ref.trim().replace(/^records\//, "").match(SLICE_REF_RE);
  if (!match) return null;
  const scenario = match[1];
  return isCanonicalScenarioId(scenario) ? scenario : null;
}
