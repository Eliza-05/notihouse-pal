import { sql, close } from '../lib.mjs';
console.log(await sql("select c.id::text, c.status, h.status hitl, (select count(*) from obligations) obl from cases c left join hitl_requests h on h.case_id=c.id order by c.created_at"));
console.log(await sql("select job_type,status,attempts from workflow_jobs order by created_at"));
console.log(await sql("select provider_name, auto_generate, due_day from obligations where provider_name='Tigo'"));
await close();
