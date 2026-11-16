// Removes every machine the harness made, or those of one run.
//
//   node teardown.mjs [--run <id>]
import { PREFIX, boxd, log, machines, options, pool } from './lib.mjs';

const { run } = options(process.argv.slice(2), { run: '' });
const prefix = run ? `${PREFIX}-${run}-` : `${PREFIX}-`;
const names = (await machines()).map(machine => machine.name).filter(name => name.startsWith(prefix));
// Every removal is attempted, whatever happens to the others.
const failed = [];
await pool(names, 8, name => boxd(['machine', 'remove', name, '-y']).catch(error => failed.push(`${name}: ${error.message}`)));
const removed = names.filter(name => !failed.some(failure => failure.startsWith(`${name}:`)));
log(removed.length ? `removed ${removed.join(' ')}` : `nothing named ${prefix}* was removed`);
if (failed.length) {
    throw new Error(`could not remove ${failed.length} of ${names.length} machines:\n${failed.join('\n')}`);
}
