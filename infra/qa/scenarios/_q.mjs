import { sql, close } from '../lib.mjs';
console.log(await sql("select c.id::text, c.status, j.job_type, j.status jstatus, j.attempts, left(coalesce(j.last_error,''),160) err from cases c left join workflow_jobs j on j.case_id=c.id order by c.created_at"));
console.log(await sql("select p.case_id::text, p.source, p.version, left(p.proposed_data::text,500) pd from case_proposals p"));
console.log(await sql("select h.case_id::text, h.decision_type, h.status, left(h.options::text,400) o from hitl_requests h"));
await close();
