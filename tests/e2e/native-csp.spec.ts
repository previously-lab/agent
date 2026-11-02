import { test, expect, type Page } from "@playwright/test";
import { buildNativeDocument, DEFAULT_NATIVE_THEME } from "../../src/lib/markdown/native-document";
import { buildNativeContainer } from "../../src/lib/markdown/native-container";
import { NATIVE_BRIDGE_CHANNEL } from "../../src/lib/chat/native-bridge";

const token = "isolated-native-token";
const host = "https://native-host.invalid/";
const content = (page: Page) => page.locator("#container").contentFrame().frameLocator("[data-native-content]");
let requests: string[];
let diagnostics: string[];
test.beforeEach(async ({ page, context }) => {
  requests = []; diagnostics = [];
  let hostLoaded = false;
  await context.route("**/*", route => {
    if (route.request().url() === host && !hostLoaded) {
      hostLoaded = true;
      return route.fulfill({ contentType: "text/html", body: '<!doctype html><p id="host">Host fixture</p>' });
    }
    requests.push(route.request().url());
    return route.abort("blockedbyclient");
  });
  page.on("console", message => diagnostics.push(message.text()));
  await page.goto(host);
});
test.afterEach(async ({ context }) => {
  expect(requests, "CSP must block before the test network interception is reached").toEqual([]);
  expect(diagnostics.filter(message => /Unrecognized.*Content-Security-Policy|Unrecognized.*navigate-to/i.test(message))).toEqual([]);
  expect(context.pages()).toHaveLength(1);
});

async function mount(page: Page, source: string, interactive = true, initialStateJson: string | null = null) {
  const innerDocument = buildNativeDocument({ source, token, theme: DEFAULT_NATIVE_THEME, locale: "en", interactive, initialStateJson, fallback: "Fixture fallback" });
  const srcdoc = buildNativeContainer({ document: innerDocument, token, interactive, title: "Fixture widget" });
  await page.evaluate(({ srcdoc, interactive }) => {
    const messages: unknown[] = [];
    (window as unknown as { fixtureMessages: unknown[] }).fixtureMessages = messages;
    const frame = document.createElement("iframe");
    frame.id = "container";
    frame.sandbox.value = interactive ? "allow-scripts allow-forms" : "";
    frame.style.cssText = "width:600px;height:500px";
    frame.srcdoc = srcdoc;
    window.addEventListener("message", event => { if (event.source === frame.contentWindow) messages.push(event.data); });
    document.body.append(frame);
  }, { srcdoc, interactive });
}
async function messages(page: Page) {
  return page.evaluate(() => (window as unknown as { fixtureMessages: Array<Record<string, unknown>> }).fixtureMessages);
}
async function post(page: Page, data: object) {
  await page.locator("#container").evaluate((element, message) => (element as HTMLIFrameElement).contentWindow!.postMessage(message, "*"), { channel: NATIVE_BRIDGE_CHANNEL, token, ...data });
}

test("initial srcdoc runs inline/module/local form; restore, theme, CSS and exact flush survive the relay", async ({ page }) => {
  await mount(page, `<!doctype html><html><head><script>document.addEventListener('DOMContentLoaded',()=>{const input=document.querySelector('#number');input.oninput=()=>document.querySelector('#derived').textContent=String(Number(input.value)*2);input.oninput();document.documentElement.dataset.instance='first';});</script></head><body>
    <input id="number" value="1"><output id="derived"></output><output id="custom"></output>
    <button id="custom-button" onclick="previously.setState({count:3});document.querySelector('#custom').textContent=previously.getState().count">Custom</button>
    <form onsubmit="event.preventDefault();document.querySelector('#sum').textContent=String(Number(document.querySelector('#number').value)+1)"><button>Calculate</button><output id="sum"></output></form>
    <script type="module">document.documentElement.dataset.module='ran';</script></body></html>`, true,
  JSON.stringify({ controls: [{ id: "id:number:0", value: "7" }], scroll: { x: 0, y: 0 }, custom: { count: 2 } }));
  const frame = content(page);
  await expect(frame.locator("#derived")).toHaveText("14");
  await expect(frame.locator("html")).toHaveAttribute("data-module", "ran");
  await frame.getByRole("button", { name: "Calculate" }).click();
  await expect(frame.locator("#sum")).toHaveText("8");
  await frame.locator("#custom-button").click();
  await post(page, { type: "flush", requestId: "exact-flush" });
  await expect.poll(async () => (await messages(page)).find(message => message.requestId === "exact-flush")?.json).toContain('"count":3');
  await post(page, { type: "theme", theme: { ...DEFAULT_NATIVE_THEME, background: "rgb(12, 34, 56)" } });
  await post(page, { type: "styles", styles: { id: "fresh-css", cssText: "#derived{font-weight:700}" } });
  await expect(frame.locator("body")).toHaveCSS("background-color", "rgb(12, 34, 56)");
  await expect(frame.locator("#previously-native-styles")).toHaveAttribute("data-version", "fresh-css");
  await expect(frame.locator("#number")).toHaveValue("7");
  await expect(frame.locator("#custom")).toHaveText("3");
  expect((await messages(page)).filter(message => message.type === "ready")).toHaveLength(1);
  expect((await messages(page)).some(message => message.type === "resize" && Number(message.height) > 0)).toBe(true);
  await post(page, { token: "wrong", type: "styles", styles: { id: "forged", cssText: "body{display:none}" } });
  await post(page, { type: "flush", requestId: "after-forgery" });
  await expect.poll(async () => (await messages(page)).some(message => message.requestId === "after-forgery")).toBe(true);
  await expect(frame.locator("#previously-native-styles")).toHaveAttribute("data-version", "fresh-css");
});

const targets: Record<string, string> = {
  external: "'https://blocked.invalid/leave'", sameOrigin: "'https://native-host.invalid/leave'",
  data: "'data:text/html,<p>data</p>'", blob: "URL.createObjectURL(new Blob(['<p>blob</p>'],{type:'text/html'}))",
  blank: "'about:blank'", srcdoc: "'about:srcdoc'",
};
for (const method of ["location", "anchor", "meta", "form"] as const) {
  for (const [variant, target] of Object.entries(targets)) {
    test(`${method} to ${variant} cannot issue a request or leave a second executing document`, async ({ page }) => {
      const action = method === "location" ? "location.href=target" : method === "anchor" ? "var a=document.createElement('a');a.href=target;document.body.append(a);a.click()"
        : method === "meta" ? "var m=document.createElement('meta');m.httpEquiv='refresh';m.content='0;url='+target;document.head.append(m)"
          : "var f=document.createElement('form');f.action=target;document.body.append(f);f.requestSubmit()";
      await mount(page, `<button id="go" onclick="run()">Go</button><script>function run(){var target=${target};${action}}</script>`);
      await expect.poll(async () => (await messages(page)).some(message => message.type === "ready")).toBe(true);
      await content(page).locator("#go").click();
      if (method === "form" && variant === "blob") {
        // Chromium refuses the local blob form before committing a new document.
        await expect.poll(() => diagnostics.some(message => /form-action|Not allowed to load local resource/.test(message))).toBe(true);
      } else {
        await expect.poll(async () => (await messages(page)).some(message => message.type === "error" && message.message === "navigation")).toBe(true);
        await expect(page.locator("#container").contentFrame().locator("[data-native-content]")).toHaveCount(0);
      }
      expect(page.url()).toBe(host);
    });
  }
}

test("opaque frames deny parent/storage, popups and top navigation while blocking resource requests", async ({ page }) => {
  await page.evaluate(() => localStorage.setItem("host-secret", "host-only"));
  await mount(page, `<button id="probe" onclick="probe()">Probe</button><output id="result"></output><script>
  function probe(){var result={};for(var key of ['parent','top','storage']){try{if(key==='parent')parent.document.body.dataset.changed='bad';else if(key==='top')top.document.body.dataset.changed='bad';else localStorage.getItem('host-secret');result[key]='allowed'}catch(e){result[key]='blocked'}}
  result.popup=window.open('https://blocked.invalid/popup')===null?'blocked':'allowed';try{top.location.href='https://blocked.invalid/top';result.navigation='allowed'}catch(e){result.navigation='blocked'}
  try{parent.location.href='https://blocked.invalid/container';result.parentNavigation='allowed'}catch(e){result.parentNavigation='blocked'}
  document.querySelector('#result').textContent=JSON.stringify(result);fetch('https://blocked.invalid/fetch').catch(()=>{});var img=new Image;img.src='https://blocked.invalid/image';document.body.append(img);
  }</script>`);
  await content(page).locator("#probe").click();
  await expect(content(page).locator("#result")).toHaveText(JSON.stringify({ parent: "blocked", top: "blocked", storage: "blocked", popup: "blocked", navigation: "blocked", parentNavigation: "blocked" }));
  await expect.poll(() => diagnostics.some(message => message.includes("connect-src"))).toBe(true);
  expect(page.url()).toBe(host);
  expect(await page.locator("body").getAttribute("data-changed")).toBeNull();
});

test("relay ignores wrong tokens and descendant sources; links cannot open popups or navigate the host", async ({ page }) => {
  await mount(page, `<a id="popup" target="_blank" href="https://blocked.invalid/popup">Popup</a><a id="top" target="_top" href="https://blocked.invalid/top">Top</a><button id="forge">Forge</button><script>
  document.querySelector('#forge').onclick=()=>{
    parent.postMessage({channel:'${NATIVE_BRIDGE_CHANNEL}',token:'wrong',type:'state',json:'forged'},'*');
    const nested=document.createElement('iframe');nested.sandbox='allow-scripts';
    nested.srcdoc='<script>parent.parent.postMessage({channel:"${NATIVE_BRIDGE_CHANNEL}",token:"${token}",type:"state",json:"forged"},"*");parent.postMessage("done","*")<'+ '/script>';
    window.addEventListener('message',event=>{if(event.source===nested.contentWindow&&event.data==='done')document.querySelector('#forge').dataset.forged='done'});
    document.body.append(nested);
  };</script>`);
  const frame = content(page);
  await frame.locator("#popup").click();
  await frame.locator("#top").click();
  await frame.locator("#forge").click();
  await expect(frame.locator("iframe")).toHaveCount(1);
  await expect(frame.locator("#forge")).toHaveAttribute("data-forged", "done");
  await post(page, { type: "flush", requestId: "source-check" });
  await expect.poll(async () => (await messages(page)).some(message => message.requestId === "source-check")).toBe(true);
  expect((await messages(page)).some(message => message.json === "forged")).toBe(false);
  expect(page.url()).toBe(host);
});

for (const target of ["https://blocked.invalid/initial", "about:blank"]) {
  test(`parser-time meta refresh to ${target} is retired without a network request`, async ({ page }) => {
    await mount(page, `<meta http-equiv="refresh" content="0;url=${target}"><p>Initial source</p>`);
    await expect.poll(async () => (await messages(page)).some(message => message.type === "error" && message.message === "navigation")).toBe(true);
    await expect(page.locator("#container").contentFrame().locator("[data-native-content]")).toHaveCount(0);
  });
}

test("static copy executes no authored script and its links cannot fetch", async ({ page }) => {
  await mount(page, '<p>Static text</p><output id="ran">no</output><script>document.querySelector("#ran").textContent="yes"</script><a href="https://blocked.invalid/static">Link</a>', false);
  await expect(content(page).locator("#ran")).toHaveText("no");
  await content(page).getByRole("link", { name: "Link" }).click();
  await expect.poll(() => diagnostics.some(message => message.includes("frame-src"))).toBe(true);
  expect(page.url()).toBe(host);
});
