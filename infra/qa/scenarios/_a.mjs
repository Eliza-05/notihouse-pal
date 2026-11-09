import { sql, close } from '../lib.mjs';
console.log(await sql("select action, count(*)::int n from audit_events group by 1 order by 1")); await close();
