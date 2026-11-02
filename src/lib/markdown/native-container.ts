import { NATIVE_BRIDGE_CHANNEL } from "@/lib/chat/native-bridge";
import { NATIVE_IFRAME_CSP } from "./native-document";

function inlineJson(value: unknown): string {
  return (JSON.stringify(value) ?? "null").replace(/</g, "\\u003c").replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}
function attribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** A trusted, opaque parent owns the child's navigation policy. The child's
 * own CSP controls fetches but cannot stop it navigating itself. Parent
 * frame-src blocks network/data/blob navigations before a request; about:
 * replacements remain possible and are retired by the load guard below.
 * Never add allow-same-origin, popups, or top-navigation to either frame. */
export function buildNativeContainer(options: {
  document: string;
  token: string;
  interactive: boolean;
  title: string;
}): string {
  const sandbox = options.interactive ? "allow-scripts allow-forms" : "";
  const csp = `${NATIVE_IFRAME_CSP}; script-src ${options.interactive ? "'unsafe-inline'" : "'none'"}`;
  const prefix = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{display:block;width:100%;height:100%;border:0}</style></head><body>`;
  if (!options.interactive) {
    return `${prefix}<iframe data-native-content title="${attribute(options.title)}" sandbox="" referrerpolicy="no-referrer" srcdoc="${attribute(options.document)}"></iframe></body></html>`;
  }
  return `${prefix}<script>(function(){
"use strict";
var TOKEN=${inlineJson(options.token)},CHANNEL=${inlineJson(NATIVE_BRIDGE_CHANNEL)};
var frame=document.createElement("iframe"),loads=0,blocked=false;
frame.setAttribute("data-native-content","");
frame.setAttribute("title",${inlineJson(options.title)});
frame.setAttribute("sandbox",${inlineJson(sandbox)});
frame.setAttribute("referrerpolicy","no-referrer");
function stop(){if(blocked)return;blocked=true;frame.remove();window.parent.postMessage({channel:CHANNEL,token:TOKEN,type:"error",message:"navigation"},"*")}
window.addEventListener("message",function(event){
 if(blocked)return;
 var data=event.data;
 if(!data||typeof data!=="object"||data.channel!==CHANNEL||data.token!==TOKEN)return;
 if(event.source===window.parent){
  if(["theme","styles","flush"].indexOf(data.type)>=0&&frame.contentWindow)frame.contentWindow.postMessage(data,"*");
 }else if(event.source===frame.contentWindow&&["ready","resize","state","followup","error"].indexOf(data.type)>=0){
  window.parent.postMessage(data,"*");
 }
});
frame.addEventListener("load",function(){if(++loads>1)stop()});
document.addEventListener("securitypolicyviolation",function(event){if(event.effectiveDirective==="frame-src")stop()});
frame.srcdoc=${inlineJson(options.document)};
document.body.append(frame);
})();</script></body></html>`;
}
