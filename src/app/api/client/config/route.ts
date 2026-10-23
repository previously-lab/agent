import { isClientMode } from "@/lib/mode";
import { guardRequest } from "@/lib/security/origin-guard";
import { ClientConfigError, readClientConfig, writeClientConfig, type ClientConfigPatch } from "@/lib/client-config";
export const dynamic="force-dynamic";
function unavailable(){return Response.json({error:"Client config is only available in client mode."},{status:404});}
function failure(e:unknown){return Response.json({error:e instanceof Error?e.message:"Client configuration failed."},{status:e instanceof ClientConfigError?e.status:500});}
export async function GET():Promise<Response>{
  if(!isClientMode())return unavailable();
  try{return Response.json(await readClientConfig());}catch(e){return failure(e);}
}
export async function POST(request:Request):Promise<Response>{
  const blocked=guardRequest(request);if(blocked)return blocked;
  if(!isClientMode())return unavailable();
  let body:unknown;
  try{body=await request.json();}catch{return Response.json({error:"Invalid JSON."},{status:400});}
  if(!body||typeof body!=="object"||Array.isArray(body))return Response.json({error:"Expected a BYOK settings object."},{status:400});
  try{return Response.json(await writeClientConfig(body as ClientConfigPatch));}catch(e){return failure(e);}
}
