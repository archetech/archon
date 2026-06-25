import base from './jest.config.js';

// Runs ONLY the in-process DIDComm relay e2e, isolated from the unit run.
// It boots the relay (createApp + listen) and makes real fetches, so it leaves
// undici keep-alive sockets that trip Jest's "import after teardown" if run in
// the shared unit suite. Here it runs alone with --forceExit (see package.json
// `test:didcomm-e2e`), so the process exits before that late cleanup fires —
// no global-dispatcher band-aid needed. The unit run still excludes this file
// (jest.config.js testPathIgnorePatterns). CLI-against-docker coverage of the
// core send/receive lives in tests/cli/didcomm.test.ts.
const config = {
    ...base,
    testMatch: ['<rootDir>/tests/didcomm/e2e.test.ts'],
    testPathIgnorePatterns: ['/node_modules/'],
};

export default config;
