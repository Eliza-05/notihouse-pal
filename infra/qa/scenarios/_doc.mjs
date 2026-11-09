import { sql, close } from '../lib.mjs';
const c = (await sql("select c.id::text, c.status from cases c join workflow_jobs j on j.case_id=c.id where j.job_type='document.process' order by c.created_at desc limit 1"))[0];
console.log(c, await sql("select job_type,status,attempts,left(coalesce(last_error,''),200) e from workflow_jobs where case_id=$1",[c.id]));
console.log(await sql("select source,version,left(proposed_data::text,420) pd from case_proposals where case_id=$1 order by version",[c.id]));
console.log(await sql("select decision_type,status from hitl_requests where case_id=$1",[c.id]));
await close();
