import { killSwitch, close } from '../lib.mjs';
console.log(killSwitch(...process.argv.slice(2))); await close();
