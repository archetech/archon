import config, { convergenceTestPathPattern } from './jest.config.js';

const unitConfig = {
    ...config,
    testPathIgnorePatterns: [...config.testPathIgnorePatterns, convergenceTestPathPattern],
};

export default unitConfig;
