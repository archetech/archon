// Removes every machine the harness made, or those of one run.
//
//   node teardown.mjs [--run <id>]
import { PREFIX, boxd, log, machines, options, pool } from './lib.mjs';

const { run } = options(process.argv.slice(2), { run: '' });
const prefix = run ? `${PREFIX}-${run}-` : `${PREFIX}-`;
const names = (await machines()).map(machine => machine.name).filter(name => name.startsWith(prefix));
await pool(names, 8, name => boxd(['machine', 'remove', name, '-y']));
log(names.length ? `removed ${names.join(' ')}` : `nothing named ${prefix}* to remove`);
