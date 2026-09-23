import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createCoverageMap } = require('istanbul-lib-coverage');
const { createContext } = require('istanbul-lib-report');
const reports = require('istanbul-reports');

const inputs = process.argv.slice(2);
if (inputs.length !== 2) {
    throw new Error('Expected unit and convergence coverage-final.json paths');
}

const coverage = createCoverageMap({});
for (const path of inputs) {
    coverage.merge(JSON.parse(readFileSync(path, 'utf8')));
}

mkdirSync('coverage', { recursive: true });
writeFileSync('coverage/coverage-final.json', JSON.stringify(coverage.toJSON()));
reports.create('lcovonly').execute(createContext({ dir: 'coverage', coverageMap: coverage }));
