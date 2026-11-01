import { afterEach, describe, expect, it, vi } from "vitest";
import { createContext, runInContext } from "node:vm";
import { buildNativeDocument, DEFAULT_NATIVE_THEME } from "@/lib/markdown/native-document";
import { NATIVE_BRIDGE_CHANNEL } from "@/lib/chat/native-bridge";

afterEach(() => vi.useRealTimers());

/** Execute the actual emitted bridge against native EventTargets and a small
 * DOM fixture. No model, network, browser service, or stored user data. */
function runtime() {
  vi.useFakeTimers();
  class Input extends EventTarget {
    id = "slider"; value = "1"; type = "range"; tagName = "INPUT";
    getAttribute(name: string) { return name === "type" ? this.type : null; }
    getBoundingClientRect() { return { width: 100, height: 20, bottom: 20, top: 0 }; }
  }
  const input = new Input();
  const second = new Input(); second.id = "other"; second.value = "2";
  const output = { value: "" };
  const sharedStyle = { textContent: "initial-css", dataset: { version: "initial" } };
  const values = new Map<string, string>();
  const root = {
    style: { setProperty: (key: string, value: string) => values.set(key, value), removeProperty: (key: string) => values.delete(key) },
    classList: { toggle: vi.fn() },
  };
  const doc = Object.assign(new EventTarget(), {
    readyState: "loading", activeElement: null, documentElement: root,
    body: { children: [input, second], getBoundingClientRect: () => ({ top: 0, height: 48 }) },
    querySelectorAll: () => [input, second],
    getElementById: (id: string) => id === "slider" ? input : id === "other" ? second : id === "output" ? output : id === "previously-native-styles" ? sharedStyle : null,
  });
  const messages: Array<Record<string, unknown>> = [];
  const parent = { postMessage: (value: Record<string, unknown>) => messages.push(value) };
  const win = Object.assign(new EventTarget(), {
    parent, setTimeout, clearTimeout, requestAnimationFrame: (fn: () => void) => setTimeout(fn, 16),
    cancelAnimationFrame: clearTimeout, scrollX: 0, scrollY: 0, scrollTo: vi.fn(),
  });
  const context = createContext({ document: doc, window: win, Event, HTMLInputElement: Input, HTMLSelectElement: class {},
    getComputedStyle: () => ({ paddingTop: "0", paddingBottom: "0" }), Map, console });
  const html = buildNativeDocument({ source: "<p>fixture</p>", token: "fixture-token", theme: DEFAULT_NATIVE_THEME, locale: "en", interactive: true, fallback: "fallback",
    initialStateJson: JSON.stringify({ controls: [{ id: "id:slider:0", value: "7" }, { id: "id:other:1", value: "9" }], scroll: { x: 0, y: 0 } }),
  });
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error("Missing bridge script");
  runInContext(script, context);
  return { input, second, output, values, sharedStyle, messages, context, doc, win, parent };
}

describe("native runtime lifecycle", () => {
  it("restores after authored DOMContentLoaded handlers, then recomputes before ready", async () => {
    const h = runtime();
    runInContext(`document.addEventListener("DOMContentLoaded", function(){
      var slider=document.getElementById("slider"), other=document.getElementById("other"), output=document.getElementById("output");
      function update(){output.value=String(Number(slider.value)*2);window.otherAtChange=other.value}
      slider.addEventListener("input",update); update();
    });`, h.context);
    h.doc.dispatchEvent(new Event("DOMContentLoaded"));
    expect(h.input.value).toBe("1");
    expect(h.output.value).toBe("2");
    expect(h.messages.some((message) => message.type === "ready")).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.input.value).toBe("7");
    expect(h.output.value).toBe("14");
    expect(runInContext("window.otherAtChange", h.context)).toBe("9");
    expect(h.messages.at(-1)?.type).toBe("ready");
    // Restoration is not a new user change and must not overwrite saved state.
    expect(h.messages.some((message) => message.type === "state")).toBe(false);
  });

  it("flushes explicit saves and control commits before the debounce expires", async () => {
    const h = runtime();
    h.doc.dispatchEvent(new Event("DOMContentLoaded"));
    await vi.advanceTimersByTimeAsync(0);
    h.input.value = "11";
    h.doc.dispatchEvent(new Event("input"));
    expect(h.messages.some((message) => message.type === "state")).toBe(false);
    runInContext("window.previously.save()", h.context);
    expect(h.messages.at(-1)?.json).toContain('"value":"11"');
    h.input.value = "12";
    h.doc.dispatchEvent(new Event("change"));
    expect(h.messages.at(-1)?.json).toContain('"value":"12"');
  });

  it("updates shared CSS separately from surface tokens without resetting live controls", async () => {
    const h = runtime();
    h.doc.dispatchEvent(new Event("DOMContentLoaded"));
    await vi.advanceTimersByTimeAsync(0);
    const send = (type: string, extra: object, source: unknown = h.parent) => {
      h.win.dispatchEvent(Object.assign(new Event("message"), { source, data: { channel: NATIVE_BRIDGE_CHANNEL, token: "fixture-token", type, ...extra } }));
    };
    send("styles", { styles: { id: "new", cssText: ".bg-primary { background: var(--primary) }" } }, {});
    expect(h.sharedStyle.dataset.version).toBe("initial");
    send("styles", { styles: { id: "new", cssText: ".bg-primary { background: var(--primary) }" } });
    expect(h.sharedStyle.dataset.version).toBe("new");
    send("theme", { theme: { ...DEFAULT_NATIVE_THEME, colorScheme: "dark", rootFontSize: "20px", cssVariables: { "--primary": "host-brand", "--text-base": "1.125rem" } } });
    expect(h.values.get("--primary")).toBe("host-brand");
    expect(h.values.get("--previously-root-font-size")).toBe("20px");
    expect(h.values.get("--text-base")).toBe("1.125rem");
    send("theme", { theme: { ...DEFAULT_NATIVE_THEME, rootFontSize: "18px" } });
    expect(h.values.get("--previously-root-font-size")).toBe("18px");
    expect(h.sharedStyle.textContent).toContain(".bg-primary");
    expect(h.input.value).toBe("7");
    expect(h.messages.filter((message) => message.type === "ready")).toHaveLength(1);
  });

  it("sends a custom-state snapshot in the same task as setState after initialization", async () => {
    const h = runtime();
    h.doc.dispatchEvent(new Event("DOMContentLoaded"));
    await vi.advanceTimersByTimeAsync(0);
    const pendingMeasurements = vi.getTimerCount();
    expect(runInContext('window.previously.setState({ count: 7 })', h.context)).toBe(true);
    expect(h.messages.at(-1)?.type).toBe("state");
    expect(h.messages.at(-1)?.json).toContain('"custom":{"count":7}');
    // The host can transfer execution ownership before 180ms; no timer is needed.
    expect(vi.getTimerCount()).toBe(pendingMeasurements);
  });

  it("acknowledges the requested flush snapshot, never an older queued state", async () => {
    const h = runtime();
    h.doc.dispatchEvent(new Event("DOMContentLoaded"));
    await vi.advanceTimersByTimeAsync(0);
    const pendingMeasurements = vi.getTimerCount();
    h.messages.length = 0;
    runInContext('window.previously.setState({ count: 1 })', h.context);
    runInContext('window.previously.setState({ count: 2 })', h.context);
    const requestId = "handoff-request-2";
    h.win.dispatchEvent(Object.assign(new Event("message"), { source: h.parent,
      data: { channel: NATIVE_BRIDGE_CHANNEL, token: "fixture-token", type: "flush", requestId } }));
    // Deliver queued messages in their original order, with no timer sleeps.
    let completed: Record<string, unknown> | undefined;
    const first = h.messages.shift()!;
    expect(first.json).toContain('"count":1');
    expect(first.requestId).toBeUndefined();
    if (first.requestId === requestId) completed = first;
    expect(completed).toBeUndefined();
    for (const message of h.messages) if (message.requestId === requestId) completed = message;
    expect(completed?.json).toContain('"count":2');
    expect(h.messages.filter((message) => message.requestId === requestId)).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(pendingMeasurements);
  });

  it("defers initialization saves and flush acknowledgements until controls and derived state are restored", async () => {
    const h = runtime();
    runInContext(`window.previously.setState({initialized:true});
      document.addEventListener("DOMContentLoaded", function(){
        var slider=document.getElementById("slider"), output=document.getElementById("output");
        function update(){output.value=String(Number(slider.value)*2);window.previously.setState({derived:output.value})}
        slider.addEventListener("input",update); update();
      });`, h.context);
    expect(h.messages).toHaveLength(0);
    h.win.dispatchEvent(Object.assign(new Event("message"), { source: h.parent,
      data: { channel: NATIVE_BRIDGE_CHANNEL, token: "fixture-token", type: "flush", requestId: "early-flush" } }));
    h.doc.dispatchEvent(new Event("DOMContentLoaded"));
    expect(h.input.value).toBe("1");
    expect(h.output.value).toBe("2");
    expect(h.messages).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(0);
    const snapshots = h.messages.filter((message) => message.type === "state");
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].requestId).toBe("early-flush");
    const saved = JSON.parse(String(snapshots[0].json));
    expect(saved.controls).toEqual([{ id: "id:slider:0", value: "7" }, { id: "id:other:1", value: "9" }]);
    expect(saved.custom).toEqual({ derived: "14" });
    expect(h.output.value).toBe("14");
    expect(h.messages.at(-1)?.type).toBe("ready");
  });
});
