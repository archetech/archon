const config = {
    setupFiles: ['<rootDir>/tests/jest.setup.ts'],
    transform: {
        '^.+\\.ts$': [
            'ts-jest',
            {
                useESM: true,
                tsconfig: './tsconfig.json',
            }
        ]
    },
    extensionsToTreatAsEsm: ['.ts'],
    testEnvironment: 'node',
    moduleFileExtensions: ['ts', 'js', 'mjs'],
    moduleNameMapper: {
        '^@didcid/clients$': '<rootDir>/packages/clients/src/index.ts',
        '^@didcid/clients/gatekeeper$': '<rootDir>/packages/clients/src/gatekeeper-client.ts',
        '^@didcid/clients/drawbridge$': '<rootDir>/packages/clients/src/drawbridge-client.ts',
        '^@didcid/clients/keymaster$': '<rootDir>/packages/clients/src/keymaster-client.ts',
        '^@didcid/clients/gatekeeper-types$': '<rootDir>/packages/clients/src/gatekeeper-types.ts',
        '^@didcid/clients/keymaster-types$': '<rootDir>/packages/clients/src/keymaster-types.ts',
        '^@didcid/cipher/node$': '<rootDir>/packages/cipher/src/cipher-node.ts',
        '^@didcid/cipher/didcomm$': '<rootDir>/packages/cipher/src/didcomm.ts',
        '^@didcid/cipher/types': '<rootDir>/packages/cipher/src/types.ts',
        '^@didcid/common/errors$': '<rootDir>/packages/common/src/errors.ts',
        '^@didcid/common/utils$': '<rootDir>/packages/common/src/utils.ts',
        '^@didcid/gatekeeper$': '<rootDir>/packages/gatekeeper/src/gatekeeper.ts',
        '^@didcid/gatekeeper/types$': '<rootDir>/packages/gatekeeper/src/types.ts',
        '^@didcid/gatekeeper/client$': '<rootDir>/packages/gatekeeper/src/gatekeeper-client.ts',
        '^@didcid/gatekeeper/drawbridge$': '<rootDir>/packages/gatekeeper/src/drawbridge-client.ts',
        '^@didcid/gatekeeper/db/(.*)$': '<rootDir>/packages/gatekeeper/src/db/$1',
        '^@didcid/ipfs/helia$': '<rootDir>/packages/ipfs/src/helia-client.ts',
        '^@didcid/ipfs/utils$': '<rootDir>/packages/ipfs/src/utils.ts',
        '^@didcid/keymaster/search$': '<rootDir>/packages/keymaster/src/search-client.ts',
        '^@didcid/keymaster$': '<rootDir>/packages/keymaster/src/keymaster.ts',
        '^@didcid/keymaster/client$': '<rootDir>/packages/keymaster/src/keymaster-client.ts',
        '^@didcid/keymaster/wallet/(.*)$': '<rootDir>/packages/keymaster/src/db/$1',
        '^@didcid/mcp-server$': '<rootDir>/packages/mcp-server/src/index.ts',
        '^@didcid/cipher/passphrase': '<rootDir>/packages/cipher/src/passphrase.ts',
        '^\\.\\/typeGuards\\.js$': '<rootDir>/packages/keymaster/src/db/typeGuards.ts',
        '^\\.\\/db\\/typeGuards\\.js$': '<rootDir>/packages/keymaster/src/db/typeGuards.ts',
        '^\\.\\/gatekeeper-client\\.js$': '<rootDir>/packages/gatekeeper/src/gatekeeper-client.ts',
        '^\\.\\/abstract-json\\.js$': '<rootDir>/packages/gatekeeper/src/db/abstract-json.ts',
        '^\\.\\/cipher-base\\.js$': '<rootDir>/packages/cipher/src/cipher-base.ts',
        '^\\.\\/jwe\\.js$': '<rootDir>/packages/cipher/src/jwe.ts',
        '^\\.\\/concat-kdf\\.js$': '<rootDir>/packages/cipher/src/concat-kdf.ts',
        '^\\.\\/abstract-base\\.js$': '<rootDir>/packages/keymaster/src/db/abstract-base.ts',
        '^\\.\\/encryption\\.js$': '<rootDir>/packages/keymaster/src/encryption.ts',
        '^\\.\\/search-index\\.js$': '<rootDir>/packages/gatekeeper/src/search-index.ts',
        '^(\\.{1,2}/.*)\\.js$': '$1',
        '^@didcid/browser-hdkey$': '<rootDir>/packages/browser-hdkey/lib/hdkey.js',
        '^@noble/curves/secp256k1$': '<rootDir>/node_modules/@noble/curves/secp256k1.js',
    },
    // Count untested files as 0% instead of leaving them invisible. Without this,
    // only files a test actually loads enter the denominator, so an entirely
    // untested surface registers no delta at all and can never show a regression
    // (see #705, #814, #815). NOTE: this REPLACES the default rather than adding
    // to it, so every directory to be measured must be listed here.
    collectCoverageFrom: [
        'packages/*/src/**/*.ts',
        'services/gatekeeper/server/src/**/*.{ts,js}',
        'services/keymaster/server/src/**/*.{ts,js}',
        'services/drawbridge/server/src/**/*.{ts,js}',
        'services/herald/server/src/**/*.{ts,js}',
        'services/didcomm/server/src/**/*.{ts,js}',

        '!**/*.d.ts',
        // Type-only modules and barrel re-exports: no meaningful runtime code.
        '!**/types.ts',
        '!**/*-types.ts',
        '!**/interfaces.ts',
        '!packages/*/src/index.ts',
        // Platform variants not exercised by the node test environment.
        '!**/cipher-web.ts',
        '!**/node.ts',
        '!**/db/web.ts',
        '!**/db/chrome.ts',
        '!packages/browser-hdkey/src/**',
        // Storage backends that need a real server. Listed by path, not by glob:
        // packages/keymaster/src/db/sqlite.ts IS tested, so `!**/db/sqlite.ts`
        // would have silently hidden 27 covered lines.
        '!**/db/mongo.ts',
        '!**/db/redis.ts',
        '!services/herald/server/src/db/sqlite.ts',
        '!services/drawbridge/server/src/store.ts',
        '!services/herald/server/src/email/sendgrid.ts',
        // CLI entry points: covered by tests/cli against docker, not the unit run.
        '!**/cli.ts',
        // Service bootstrap: builds the app and listens, so it cannot be imported
        // in-process. Its routes live in the extracted routers, which are measured.
        '!services/*/server/src/index.ts',
        '!services/*/server/src/*-api.ts',
    ],
    testPathIgnorePatterns: [
        "/node_modules/",
        "/kc-app/",
        "/client/",
        "/tests/cli/",
        // In-process HTTP e2e (boots the relay + makes real fetches) — excluded from
        // the unit run because it leaves undici sockets that trip Jest's "import after
        // teardown". It runs isolated via `npm run test:didcomm-e2e`
        // (jest.config.didcomm-e2e.js, --forceExit); core send/receive is also covered
        // against docker by tests/cli/didcomm.test.ts.
        "/tests/didcomm/e2e\\.test\\.ts$"
    ]
};

export default config;
