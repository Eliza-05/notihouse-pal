import { n8nRun, mock, close } from '../lib.mjs';
const id = process.argv[2];
const r = n8nRun(id); const m = /"status": "(\w+)",\s*"finished"/.exec(r.out);
console.log('exit', r.status, 'execution status:', m?.[1], '| gemini', JSON.stringify(await mock('/__stats')));
await close();
