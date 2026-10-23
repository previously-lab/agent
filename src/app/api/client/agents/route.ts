/** External agent execution was retired; history import is a separate feature. */
export async function GET():Promise<Response>{
  return Response.json({error:"External agent execution is no longer supported. Configure a DeepSeek API key."},{status:410});
}
