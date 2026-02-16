const config = {
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
    testMatch: ['<rootDir>/tests/cli/**/*.test.ts'],
    testTimeout: 30000,
    reporters: [
        'default',
        ['jest-junit', { outputDirectory: '.', outputName: 'e2e-results.xml' }],
    ],
};

export default config;
