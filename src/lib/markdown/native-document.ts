import {
  NATIVE_BRIDGE_CHANNEL,
  NATIVE_FOLLOWUP_MAX_CHARS,
  NATIVE_STATE_MESSAGE_MAX_CHARS,
  type NativeThemeTokens,
} from "@/lib/chat/native-bridge";

export const NATIVE_IFRAME_CSP = [
  "default-src 'none'",
  "connect-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "navigate-to 'none'",
  "img-src data: blob:",
  "media-src data: blob:",
  "font-src data:",
  "style-src 'unsafe-inline'",
].join("; ");

function inlineJson(value: unknown): string {
  return (JSON.stringify(value) ?? "null")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function cssValue(value: string): string {
  return value.replace(/</g, "\\3c ").replace(/>/g, "\\3e ");
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function hasReadableStaticSource(source: string): boolean {
  const visible = source
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, "")
    .replace(/<title\b[\s\S]*?<\/title\s*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!doctype[^>]*>/gi, "")
    .replace(/<\/?(?:html|head|body)\b[^>]*>/gi, "")
    .replace(/<(?:meta|link|base)\b[^>]*>/gi, "");
  return /<\/?[a-z][^>]*>/i.test(visible) || visible.replace(/<[^>]*>/g, "").trim().length > 0;
}

export function readNativeTheme(surface: "chat" | "paper"): NativeThemeTokens {
  const styles = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string): string => styles.getPropertyValue(name).trim() || fallback;
  return {
    background: token(surface === "paper" ? "--paper" : "--background", surface === "paper" ? "#f8f6ee" : "#f8f9fb"),
    foreground: token(surface === "paper" ? "--card-foreground" : "--foreground", "#1b2940"),
    muted: token("--muted", "#edf1f6"),
    mutedForeground: token("--muted-foreground", "#59677b"),
    border: token("--border", "#c6d0df"),
    brand: token("--ink-accent-paper", "#0057d9"),
    fontBody: token("--font-serif", 'Georgia, "Times New Roman", serif'),
    fontHeading: token("--font-serif", 'Georgia, "Times New Roman", serif'),
    fontMono: token("--font-mono", 'ui-monospace, "SFMono-Regular", Consolas, monospace'),
    colorScheme: document.documentElement.classList.contains("dark") ? "dark" : "light",
  };
}

export const DEFAULT_NATIVE_THEME: NativeThemeTokens = {
  background: "#f8f9fb",
  foreground: "#1b2940",
  muted: "#edf1f6",
  mutedForeground: "#59677b",
  border: "#c6d0df",
  brand: "#0057d9",
  fontBody: 'Georgia, "Times New Roman", serif',
  fontHeading: 'Georgia, "Times New Roman", serif',
  fontMono: 'ui-monospace, "SFMono-Regular", Consolas, monospace',
  colorScheme: "light",
};

function baseStyles(theme: NativeThemeTokens): string {
  const values: Record<string, string> = {
    "--previously-background": theme.background,
    "--previously-foreground": theme.foreground,
    "--previously-muted": theme.muted,
    "--previously-muted-foreground": theme.mutedForeground,
    "--previously-border": theme.border,
    "--previously-brand": theme.brand,
    "--previously-font-body": theme.fontBody,
    "--previously-font-heading": theme.fontHeading,
    "--previously-font-mono": theme.fontMono,
  };
  const declarations = Object.entries(values).map(([key, value]) => `${key}:${cssValue(value)}`).join(";");
  return `:root{${declarations};color-scheme:${theme.colorScheme};background:var(--previously-background);color:var(--previously-foreground);font-family:var(--previously-font-body);line-height:1.65}*,*::before,*::after{box-sizing:border-box}body{margin:0;padding:1rem;background:var(--previously-background);color:var(--previously-foreground);overflow-wrap:anywhere}h1,h2,h3,h4,h5,h6{font-family:var(--previously-font-heading);line-height:1.25;text-wrap:balance}p{text-wrap:pretty}img,svg,video,canvas{max-width:100%}img,video{height:auto}pre,code{font-family:var(--previously-font-mono)}pre{max-width:100%;overflow:auto}table{max-width:100%;border-collapse:collapse}button,input,select,textarea{font:inherit}button{cursor:pointer}a{color:var(--previously-brand);text-underline-offset:.15em}:where(a,button,input,select,textarea,summary):focus-visible{outline:2px solid var(--previously-brand);outline-offset:3px}::selection{background:var(--previously-muted)}@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}`;
}

function runtimeScript(token: string, initialStateJson: string | null, theme: NativeThemeTokens): string {
  const serializedToken = inlineJson(token);
  const serializedState = inlineJson(initialStateJson);
  const serializedTheme = inlineJson(theme);
  return `(function(){
"use strict";
var TOKEN=${serializedToken};
var CHANNEL=${inlineJson(NATIVE_BRIDGE_CHANNEL)};
var MAX_STATE=${NATIVE_STATE_MESSAGE_MAX_CHARS};
var MAX_FOLLOWUP=${NATIVE_FOLLOWUP_MAX_CHARS};
var initial=null;
try{var raw=${serializedState};if(raw)initial=JSON.parse(raw)}catch(_error){}
var custom=initial&&Object.prototype.hasOwnProperty.call(initial,"custom")?initial.custom:undefined;
var saveTimer=0;
var measureFrame=0;
var lastHeight=0;
var restoring=false;
function post(message){message.channel=CHANNEL;message.token=TOKEN;window.parent.postMessage(message,"*")}
function controls(){return Array.prototype.slice.call(document.querySelectorAll("input,select,textarea"))}
function skipped(el){var type=(el.getAttribute("type")||"").toLowerCase();return type==="file"||type==="password"||type==="button"||type==="submit"||type==="reset"||type==="image"}
function identity(el,index){return (el.id?"id:"+el.id:el.tagName.toLowerCase()+":"+(el.getAttribute("name")||"anonymous"))+":"+index}
function readControl(el){if(el instanceof HTMLSelectElement&&el.multiple)return Array.prototype.map.call(el.selectedOptions,function(option){return option.value});if(el instanceof HTMLInputElement&&(el.type==="checkbox"||el.type==="radio"))return el.checked;return el.value}
function sameControl(a,b){if(Array.isArray(a)&&Array.isArray(b))return a.length===b.length&&a.every(function(value,index){return value===b[index]});return a===b}
function capture(){var result=[];controls().forEach(function(el,index){if(!skipped(el))result.push({id:identity(el,index),value:readControl(el)})});return result}
function stateJson(){var state={controls:capture(),scroll:{x:window.scrollX,y:window.scrollY}};if(custom!==undefined)state.custom=custom;return JSON.stringify(state)}
function postState(){try{var json=stateJson();if(json.length<=MAX_STATE)post({type:"state",json:json})}catch(_error){}}
function scheduleSave(){if(restoring)return;window.clearTimeout(saveTimer);saveTimer=window.setTimeout(postState,180)}
function restoreControls(snapshot){if(!snapshot)return;var active=document.activeElement;var activeId=active&&active.id||"";var selection=active&&(active.selectionStart!=null)?[active.selectionStart,active.selectionEnd]:null;var saved=new Map((snapshot.controls||[]).map(function(entry){return [entry.id,entry.value]}));var changed=[];controls().forEach(function(el,index){if(skipped(el))return;var value=saved.get(identity(el,index));if(value===undefined)return;var before=readControl(el);try{if(el instanceof HTMLSelectElement&&el.multiple&&Array.isArray(value)){Array.prototype.forEach.call(el.options,function(option){option.selected=value.indexOf(option.value)>=0})}else if(el instanceof HTMLInputElement&&(el.type==="checkbox"||el.type==="radio")&&typeof value==="boolean"){el.checked=value}else if(typeof value==="string"){el.value=value}if(!sameControl(before,readControl(el)))changed.push(el)}catch(_error){}});changed.forEach(function(el){el.dispatchEvent(new Event("input",{bubbles:true}));el.dispatchEvent(new Event("change",{bubbles:true}))});if(activeId){var next=document.getElementById(activeId);if(next){next.focus({preventScroll:true});if(selection&&next.setSelectionRange)next.setSelectionRange(selection[0],selection[1])}}}
function restore(){restoring=true;restoreControls(initial);restoring=false;window.requestAnimationFrame(function(){if(initial&&initial.scroll)window.scrollTo(initial.scroll.x||0,initial.scroll.y||0);scheduleMeasure()})}
function updateFallback(){var fallback=document.getElementById("previously-native-fallback");if(!fallback)return;var body=document.body;var meaningful=false;for(var i=0;i<body.childNodes.length;i++){var node=body.childNodes[i];if(node===fallback)continue;if(node.nodeType===3&&node.nodeValue&&node.nodeValue.trim()){meaningful=true;break}if(node.nodeType!==1)continue;var el=node;if(el.tagName==="SCRIPT"||el.tagName==="STYLE")continue;if((el.textContent||"").trim()){meaningful=true;break}var rect=el.getBoundingClientRect();if(rect.width>0&&rect.height>0){meaningful=true;break}}fallback.hidden=meaningful}
function measure(){var body=document.body;if(!body)return;updateFallback();var rect=body.getBoundingClientRect();var styles=getComputedStyle(body);var top=parseFloat(styles.paddingTop)||0;var bottom=parseFloat(styles.paddingBottom)||0;var height=Math.max(top+bottom,rect.height);if(document.createRange){var range=document.createRange();range.selectNodeContents(body);height=Math.max(height,range.getBoundingClientRect().height+top+bottom)}for(var i=0;i<body.children.length;i++){var el=body.children[i];if(el.tagName==="SCRIPT"||el.tagName==="STYLE")continue;var child=el.getBoundingClientRect();height=Math.max(height,child.bottom-rect.top+bottom)}height=Math.ceil(Math.max(48,Math.min(32768,height)));if(height!==lastHeight){lastHeight=height;post({type:"resize",height:height})}}
function scheduleMeasure(){if(measureFrame)window.cancelAnimationFrame(measureFrame);measureFrame=window.requestAnimationFrame(function(){measureFrame=0;measure()})}
function applyTheme(theme){if(!theme||typeof theme!=="object")return;var names={background:"--previously-background",foreground:"--previously-foreground",muted:"--previously-muted",mutedForeground:"--previously-muted-foreground",border:"--previously-border",brand:"--previously-brand",fontBody:"--previously-font-body",fontHeading:"--previously-font-heading",fontMono:"--previously-font-mono"};Object.keys(names).forEach(function(key){var value=theme[key];if(typeof value==="string"&&value.length<2048)document.documentElement.style.setProperty(names[key],value)});if(theme.colorScheme==="dark"||theme.colorScheme==="light")document.documentElement.style.colorScheme=theme.colorScheme;scheduleMeasure()}
function clone(value){return value===undefined?undefined:JSON.parse(JSON.stringify(value))}
var api={getState:function(){return clone(custom)},setState:function(value){try{var json=JSON.stringify(value);if(json===undefined||json.length>8192)return false;custom=JSON.parse(json);scheduleSave();return true}catch(_error){return false}},save:function(){scheduleSave();return true},suggestFollowup:function(prompt){if(restoring||typeof prompt!=="string"||prompt.length>MAX_FOLLOWUP||!prompt.trim())return false;post({type:"followup",prompt:prompt});return true}};
try{Object.freeze(api);Object.defineProperty(window,"previously",{value:api,configurable:false,writable:false})}catch(_error){}
document.addEventListener("input",scheduleSave,{passive:true});
document.addEventListener("change",scheduleSave,{passive:true});
document.addEventListener("scroll",scheduleSave,{passive:true,capture:true});
window.addEventListener("pagehide",postState);
window.addEventListener("resize",scheduleMeasure,{passive:true});
window.addEventListener("message",function(event){if(event.source!==window.parent)return;var data=event.data;if(!data||data.channel!==CHANNEL||data.token!==TOKEN||data.type!=="theme")return;applyTheme(data.theme)});
window.addEventListener("error",function(event){post({type:"error",message:String(event.message||"Script error")})});
window.addEventListener("unhandledrejection",function(event){post({type:"error",message:String(event.reason&&event.reason.message||event.reason||"Unhandled rejection")})});
function ready(){restore();applyTheme(${serializedTheme});measure();if(window.ResizeObserver){var observer=new ResizeObserver(scheduleMeasure);observer.observe(document.documentElement);observer.observe(document.body)}if(window.MutationObserver){var mutations=new MutationObserver(scheduleMeasure);mutations.observe(document.body,{childList:true,subtree:true,characterData:true,attributes:true})}if(document.fonts&&document.fonts.ready)document.fonts.ready.then(scheduleMeasure).catch(function(){});post({type:"ready"})}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",ready,{once:true});else ready();
})();`;
}

export function buildNativeDocument(options: {
  source: string;
  token: string;
  theme: NativeThemeTokens;
  locale: string;
  interactive: boolean;
  initialStateJson?: string | null;
  fallback: string;
}): string {
  const scriptPolicy = options.interactive ? "script-src 'unsafe-inline'" : "script-src 'none'";
  const csp = `${NATIVE_IFRAME_CSP}; ${scriptPolicy}`;
  const prefix = `<!DOCTYPE html><html lang="${escapeAttribute(options.locale.slice(0, 24))}"><head><meta http-equiv="Content-Security-Policy" content="${csp}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${baseStyles(options.theme)}</style></head><body>`;
  const runtime = options.interactive ? `<script>${runtimeScript(options.token, options.initialStateJson ?? null, options.theme)}</script>` : "";
  const hideFallback = !options.interactive && hasReadableStaticSource(options.source);
  const fallback = `<div id="previously-native-fallback" role="status"${hideFallback ? " hidden" : ""}>${escapeHtml(options.fallback)}</div>`;
  return `${prefix}${runtime}${fallback}${options.source}</body></html>`;
}
