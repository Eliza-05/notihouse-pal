import { sql, close } from '../lib.mjs';
console.log(await sql(process.argv[2])); await close();
