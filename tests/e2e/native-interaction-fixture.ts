import { makeSlice, type FixtureSlice } from "./memory-fixture";

/** Fictional equivalents of ordinary inline calculators. No user records,
 * external scripts, model calls, or hand-written theme colors are included. */
export function calculatorDocument(): string {
  return `<!DOCTYPE html>
<html><head><title>Offline calculator fixture</title>
<script>
document.addEventListener('DOMContentLoaded', function () {
  document.getElementById('add').addEventListener('click', function () { calculate('add'); });
  document.getElementById('local-calc').addEventListener('submit', function (event) {
    event.preventDefault(); calculate('submit');
  });
});
</script>
<script type="module">
document.getElementById('subtract').addEventListener('click', () => calculate('subtract'));
</script>
</head><body>
<section class="rounded-lg border border-border bg-card text-card-foreground p-4" id="calculator">
<h2 class="text-xl font-semibold">Fictional calculator</h2>
<form id="local-calc">
<label for="left">Left</label><input id="left" type="number" value="6">
<label for="right">Right</label><input id="right" type="number" value="4">
<button id="add" type="button">Add with head script</button>
<button type="button" onclick="calculate('multiply')">Multiply inline</button>
<button id="subtract" type="button">Subtract with module</button>
<button type="submit">Submit locally</button>
<output id="result" aria-live="polite">Ready</output>
</form>
<label for="rsi">Fictional level</label><input id="rsi" type="range" min="0" max="100" value="20">
<output id="level">40</output>
<div><button id="custom-step" type="button">Add saved step</button>
<output id="custom-count">1</output> steps = <output id="custom-total">7</output> points</div>
</section>
<script>
document.documentElement.dataset.fixtureRun = Math.random().toString(36).slice(2);
function calculate(operation) {
  const left = Number(document.getElementById('left').value);
  const right = Number(document.getElementById('right').value);
  const value = operation === 'multiply' ? left * right : operation === 'subtract' ? left - right : left + right;
  document.getElementById('result').textContent = operation + ':' + value;
}
document.addEventListener('DOMContentLoaded', function () {
  const rsi = document.getElementById('rsi');
  function updateLevel() { document.getElementById('level').textContent = String(Number(rsi.value) * 2); }
  rsi.addEventListener('input', updateLevel);
  rsi.addEventListener('change', updateLevel);
  let clicks = window.previously.getState()?.clicks ?? 1;
  // Common widget initialization: publishing custom defaults must not replace
  // restored controls with the HTML's initial values before bridge restore.
  window.previously.setState({ clicks });
  function renderCustom() {
    document.getElementById('custom-count').textContent = String(clicks);
    document.getElementById('custom-total').textContent = String(clicks * 7);
  }
  document.getElementById('custom-step').addEventListener('click', function () {
    clicks += 1;
    window.previously.setState({ clicks });
    renderCustom();
  });
  renderCustom();
});
</script></body></html>`;
}

export function liveFence(source: string): string {
  return `\`\`\`html live\n${source}\n\`\`\`\n`;
}

export function interactiveRecord(source: string): FixtureSlice {
  const at = new Date().toISOString();
  const slice = makeSlice(at, { tag: "NATIVE-INTERACTION" });
  delete slice.closedBy;
  delete slice.end;
  slice.turns = [
    { role: "user", at, content: "Show the fictional local calculator.", turnId: "calculator-turn" },
    { role: "agent", at, content: liveFence(source), turnId: "calculator-turn" },
  ];
  return slice;
}

export const THEME_PROBES = [
  { id: "theme-card", classes: "bg-card text-card-foreground border border-border rounded-lg p-4 font-sans text-sm" },
  { id: "theme-muted", classes: "bg-muted text-muted-foreground rounded-md px-3 py-2 font-mono text-xs" },
  { id: "theme-primary", classes: "bg-primary text-primary-foreground rounded-lg px-4 py-2 font-semibold" },
] as const;

export function themedCalculator(): string {
  const probes = THEME_PROBES.map(({ id, classes }) => `<div id="${id}" class="${classes}">Shared style fixture</div>`).join("\n");
  return calculatorDocument().replace("</section>", `${probes}</section>`);
}

export function sliderDocument(name: string, value: number): string {
  return `<section><h2>Fictional slider ${name}</h2>
<label for="amount">Level ${name}</label><input id="amount" type="range" min="0" max="100" value="${value}">
<output id="value">${value * 2}</output></section>
<script>
document.documentElement.dataset.fixtureName = ${JSON.stringify(name)};
document.documentElement.dataset.fixtureRun = Math.random().toString(36).slice(2);
const input = document.getElementById('amount');
const update = () => document.getElementById('value').textContent = String(Number(input.value) * 2);
input.addEventListener('input', update); input.addEventListener('change', update); update();
</script>`;
}

export function sandboxCalculator(): string {
  return calculatorDocument().replace("</body>", `
<form action="https://native-fixture.invalid/submit" method="post"><button type="submit">Attempt external submission</button></form>
<script>
const root = document.documentElement;
try { parent.document.documentElement; root.dataset.parentAccess = 'allowed'; } catch { root.dataset.parentAccess = 'denied'; }
try { localStorage.getItem('fixture'); root.dataset.storageAccess = 'allowed'; } catch { root.dataset.storageAccess = 'denied'; }
fetch('https://native-fixture.invalid/read').then(() => root.dataset.externalFetch = 'allowed').catch(() => root.dataset.externalFetch = 'denied');
fetch('http://localhost:3100/api/chat', { method: 'POST', body: '{}' }).then(() => root.dataset.hostFetch = 'allowed').catch(() => root.dataset.hostFetch = 'denied');
</script></body>`);
}
