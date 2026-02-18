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
        '^@didcid/keymaster$': '<rootDir>/packages/keymaster/src/keymaster.ts',
        '^@didcid/keymaster/client$': '<rootDir>/packages/keymaster/src/keymaster-client.ts',
        '^@didcid/keymaster/wallet/(.*)$': '<rootDir>/packages/keymaster/src/db/$1',
        '^@didcid/keymaster/encryption': '<rootDir>/packages/keymaster/src/encryption.ts',
        '^\\.\\/typeGuards\\.js$': '<rootDir>/packages/keymaster/src/db/typeGuards.ts',
        '^\\.\\/db\\/typeGuards\\.js$': '<rootDir>/packages/keymaster/src/db/typeGuards.ts',
        '^\\.\\/abstract-json\\.js$': '<rootDir>/packages/gatekeeper/src/db/abstract-json.ts',
        '^\\.\\/cipher-base\\.js$': '<rootDir>/packages/cipher/src/cipher-base.ts',
        '^\\.\\/jwe\\.js$': '<rootDir>/packages/cipher/src/jwe.ts',
        '^\\.\\/concat-kdf\\.js$': '<rootDir>/packages/cipher/src/concat-kdf.ts',
        '^\\.\\/abstract-base\\.js$': '<rootDir>/packages/keymaster/src/db/abstract-base.ts',
        '^\\.\\/encryption\\.js$': '<rootDir>/packages/keymaster/src/encryption.ts',
        '^\\.\\/search-index\\.js$': '<rootDir>/packages/gatekeeper/src/search-index.ts',
        '^@didcid/browser-hdkey$': '<rootDir>/packages/browser-hdkey/lib/hdkey.js',
    },
    testPathIgnorePatterns: [
        "/node_modules/",
        "/kc-app/",
        "/client/",
        "/tests/cli/"
    ]
};

export default config;
