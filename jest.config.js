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
        '^@didcid/cipher/node$': '<rootDir>/packages/cipher/src/cipher-node.ts',
        '^@didcid/cipher/types': '<rootDir>/packages/cipher/src/types.ts',
        '^@didcid/common/errors$': '<rootDir>/packages/common/src/errors.ts',
        '^@didcid/common/utils$': '<rootDir>/packages/common/src/utils.ts',
        '^@didcid/gatekeeper$': '<rootDir>/packages/gatekeeper/src/gatekeeper.ts',
        '^@didcid/gatekeeper/types$': '<rootDir>/packages/gatekeeper/src/types.ts',
        '^@didcid/gatekeeper/client$': '<rootDir>/packages/gatekeeper/src/gatekeeper-client.ts',
        '^@didcid/gatekeeper/db/(.*)$': '<rootDir>/packages/gatekeeper/src/db/$1',
        '^@didcid/ipfs/helia$': '<rootDir>/packages/ipfs/src/helia-client.ts',
        '^@didcid/ipfs/utils$': '<rootDir>/packages/ipfs/src/utils.ts',
        '^@didcid/keymaster/search$': '<rootDir>/packages/keymaster/src/search-client.ts',
        '^@didcid/keymaster$': '<rootDir>/packages/keymaster/src/index.ts',
        '^@didcid/keymaster/client$': '<rootDir>/packages/keymaster/src/keymaster-client.ts',
        '^@didcid/keymaster/wallet/(.*)$': '<rootDir>/packages/keymaster/src/db/$1',
        '^@didcid/keymaster/encryption': '<rootDir>/packages/keymaster/src/encryption.ts',
        '^\\./typeGuards\\.js$': '<rootDir>/packages/keymaster/src/db/typeGuards.ts',
        '^\\./db/typeGuards\\.js$': '<rootDir>/packages/keymaster/src/db/typeGuards.ts',
        '^\\./abstract-json\\.js$': '<rootDir>/packages/gatekeeper/src/db/abstract-json.ts',
        '^\\./cipher-base\\.js$': '<rootDir>/packages/cipher/src/cipher-base.ts',
        '^\\./abstract-base\\.js$': '<rootDir>/packages/keymaster/src/db/abstract-base.ts',
        '^\\./encryption\\.js$': '<rootDir>/packages/keymaster/src/encryption.ts',
        '^\\./vault-mixin\\.js$': '<rootDir>/packages/keymaster/src/vault-mixin.ts',
        '^\\./dmail-mixin\\.js$': '<rootDir>/packages/keymaster/src/dmail-mixin.ts',
        '^\\./group-mixin\\.js$': '<rootDir>/packages/keymaster/src/group-mixin.ts',
        '^\\./schema-mixin\\.js$': '<rootDir>/packages/keymaster/src/schema-mixin.ts',
        '^\\./document-mixin\\.js$': '<rootDir>/packages/keymaster/src/document-mixin.ts',
        '^\\./poll-mixin\\.js$': '<rootDir>/packages/keymaster/src/poll-mixin.ts',
        '^\\./credential-mixin\\.js$': '<rootDir>/packages/keymaster/src/credential-mixin.ts',
        '^\\./notice-mixin\\.js$': '<rootDir>/packages/keymaster/src/notice-mixin.ts',
        '^\\./keymaster\\.js$': '<rootDir>/packages/keymaster/src/keymaster.ts',
        '^\\./keymaster-client\\.js$': '<rootDir>/packages/keymaster/src/keymaster-client.ts',
        '^\\./types\\.js$': '<rootDir>/packages/keymaster/src/types.ts',
        '^\\./db/json-memory\\.js$': '<rootDir>/packages/keymaster/src/db/json-memory.ts',
        '^\\./db/web\\.js$': '<rootDir>/packages/keymaster/src/db/web.ts',
        '^\\./db/cache\\.js$': '<rootDir>/packages/keymaster/src/db/cache.ts',
        '^\\./db/chrome\\.js$': '<rootDir>/packages/keymaster/src/db/chrome.ts',
        '^\\./db/abstract-base\\.js$': '<rootDir>/packages/keymaster/src/db/abstract-base.ts',
        '^\\./search-index\\.js$': '<rootDir>/packages/gatekeeper/src/search-index.ts',
        '^@didcid/browser-hdkey$': '<rootDir>/packages/browser-hdkey/lib/hdkey.js',
    },
    testPathIgnorePatterns: [
        "/node_modules/",
        "/kc-app/",
        "/client/"
    ]
};

export default config;
