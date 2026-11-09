import { sql, close } from '../lib.mjs';
console.log((await sql("select column_name from information_schema.columns where table_name=$1",[process.argv[2]])).map(r=>r.column_name).join(',')); await close();
