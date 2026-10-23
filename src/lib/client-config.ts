/** Local BYOK settings. Public snapshots never contain credentials. */
import { readFile, writeFile, rename, rm, mkdir, chmod } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { parseByok, type ClientByok } from "./byok-parse";
export type { ClientByok } from "./byok-parse";
export interface ClientConfigFile {
  storage?: string; memoryRoot?: string; port?: number; hostname?: string;
  byok?: ClientByok | null; apiKeys?: Record<string,string>; [key:string]:unknown;
}
export interface ClientConfigSnapshot {
  home: string|null; path: string|null; exists: boolean;
  byok: {provider:"deepseek"; model:"deepseek-flash"; configured:boolean; keyPreview?:string};
}
export interface ClientConfigPatch {
  byok?: {apiKey?:string; provider?:"deepseek"; model?:"deepseek-flash"} | null;
}
export class ClientConfigError extends Error {
  constructor(message:string, readonly status=400) { super(message); }
}
export function getPreviouslyHome():string|null {
  return process.env.PREVIOUSLY_HOME?.trim() || null;
}
async function readRaw(path:string):Promise<ClientConfigFile|null> {
  try {
    const value:unknown=JSON.parse(await readFile(path,"utf8"));
    if (!value || typeof value!=="object" || Array.isArray(value)) throw new Error("expected a JSON object");
    return value as ClientConfigFile;
  } catch(error) {
    if ((error as NodeJS.ErrnoException).code==="ENOENT") return null;
    throw new ClientConfigError("Could not read the local client configuration.",500);
  }
}
function credential(raw:ClientConfigFile|null):ClientByok|null {
  if (!raw) return null;
  return parseByok(raw.byok) ?? (raw.byok == null ? parseByok({
    provider:"deepseek",apiKey:raw.apiKeys?.DEEPSEEK_API_KEY,
  }) : null);
}
export async function readClientConfig():Promise<ClientConfigSnapshot> {
  const home=getPreviouslyHome();
  const path=home ? join(home,"config.json") : null;
  const raw=path ? await readRaw(path) : null;
  const byok=credential(raw);
  return {home,path,exists:raw!==null,byok:{
    provider:"deepseek",model:"deepseek-flash",configured:!!byok,
    ...(byok ? {keyPreview:byok.apiKey.length>8 ? "…"+byok.apiKey.slice(-4) : "configured"} : {}),
  }};
}
export async function writeClientConfig(patch:ClientConfigPatch):Promise<ClientConfigSnapshot> {
  const home=getPreviouslyHome();
  if (!home) throw new ClientConfigError("PREVIOUSLY_HOME is not configured.",500);
  if (!patch || typeof patch!=="object" || !("byok" in patch) ||
      Object.keys(patch).some(k=>k!=="byok")) throw new ClientConfigError("Only DeepSeek BYOK settings can be updated.");
  const path=join(home,"config.json");
  const raw=await readRaw(path) ?? {};
  let next=credential(raw);
  const input=patch.byok;
  if (input === null) next=null;
  else {
    if (!input || typeof input!=="object" || Array.isArray(input)) throw new ClientConfigError("byok must be an object or null.");
    if (Object.keys(input).some(k=>!["apiKey","provider","model"].includes(k))) throw new ClientConfigError("Unsupported BYOK setting.");
    if (input.provider!==undefined && input.provider!=="deepseek") throw new ClientConfigError("Only DeepSeek is supported.");
    if (input.model!==undefined && input.model!=="deepseek-flash") throw new ClientConfigError("The model is fixed to deepseek-flash.");
    if (input.apiKey!==undefined) {
      if (typeof input.apiKey!=="string") throw new ClientConfigError("apiKey must be a string.");
      next=input.apiKey.trim() ? {provider:"deepseek",model:"deepseek-flash",apiKey:input.apiKey.trim()} : null;
    }
  }
  const merged:ClientConfigFile={...raw,byok:next};
  // Remove obsolete execution settings; never modify memory paths/data.
  for (const key of ["brain","agents","executionBackend"]) delete merged[key];
  // Clearing BYOK must not resurrect the legacy stored DeepSeek credential.
  if (merged.apiKeys) {
    merged.apiKeys={...merged.apiKeys};
    delete merged.apiKeys.DEEPSEEK_API_KEY;
  }
  await mkdir(home,{recursive:true});
  const tmp=join(home,"config."+randomUUID()+".tmp");
  try {
    await writeFile(tmp,JSON.stringify(merged,null,2)+"\n",{encoding:"utf8",mode:0o600});
    await rename(tmp,path);
    if (process.platform!=="win32") await chmod(path,0o600);
  } catch {
    await rm(tmp,{force:true}).catch(()=>{});
    throw new ClientConfigError("Could not save the local client configuration.",500);
  }
  return readClientConfig();
}
