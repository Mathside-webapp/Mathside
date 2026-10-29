import { withSupabase } from 'npm:@supabase/server@1.8.0'
const handler = withSupabase({ auth: 'user' }, async (req, ctx) => {
  if (req.method !== 'POST') return Response.json({error:'Method not allowed'}, {status:405})
  const teacherId=ctx.userClaims?.id
  const {data:profile}=await ctx.supabase.from('mathside_profiles').select('role').eq('id',teacherId).maybeSingle()
  if(profile?.role!=='teacher') return Response.json({error:'Teacher account required'},{status:403})
  const body=await req.json().catch(()=>({}))
  const assignmentId=String(body?.assignment_id||'')
  if(!/^[a-f0-9-]{36}$/i.test(assignmentId)) return Response.json({error:'Valid activity required'},{status:400})
  const {data:assignment,error:lookupError}=await ctx.supabase.from('mathside_assignments')
    .select('id,teacher_id,title').eq('id',assignmentId).eq('teacher_id',teacherId).maybeSingle()
  if(lookupError||!assignment) return Response.json({error:'Activity not found or not owned'},{status:404})
  // No Supabase Storage calls. Cloudflare R2 cleanup will be configured later.
  const {error}=await ctx.supabase.from('mathside_assignments').delete().eq('id',assignmentId).eq('teacher_id',teacherId)
  if(error) return Response.json({error:error.message},{status:400})
  return Response.json({ok:true,assignment,deleted_storage_files:0,deleted_assignment_images:0,deleted_submission_files:0})
})
export default { fetch: handler }
