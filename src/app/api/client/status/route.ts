import { APP_VERSION } from "@/lib/version/constants";
import { getMode, isClientMode } from "@/lib/mode";
import { getPreviouslyHome, readClientConfig } from "@/lib/client-config";
import { getMemoryRoot } from "@/lib/whitelist";
import { FIXED_MODEL } from "@/lib/models/registry";
export const dynamic="force-dynamic";
export async function GET():Promise<Response>{
  if(!isClientMode())return Response.json({error:"Client status is only available in client mode."},{status:404});
  let memoryRoot:string|null;
  try{memoryRoot=getMemoryRoot();}catch{memoryRoot=null;}
  const config=await readClientConfig();
  return Response.json({
    mode:getMode(),version:APP_VERSION,memoryRoot,home:getPreviouslyHome(),
    byok:config.byok,
    models:[{id:FIXED_MODEL.id,name:FIXED_MODEL.name,provider:"deepseek",providerName:"DeepSeek"}],
  });
}
