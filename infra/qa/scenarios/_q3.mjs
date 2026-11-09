import { sql, close } from '../lib.mjs';
console.log(await sql("select provider_name, auto_generate, due_day, reminder_days_before, frequency from obligations where provider_name='Tigo'"));
console.log(await sql("select o.provider_name, oc.period_start::text, oc.due_date::text, oc.status from obligation_occurrences oc join obligations o on o.id=oc.obligation_id where o.provider_name='Tigo'"));
console.log(await sql("select c.status from cases c where id='c14af1db-635a-4ed5-984a-baa5ad5c5934'"));
await close();
