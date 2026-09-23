import config, { convergenceTestPathPattern } from './jest.config.js';

export default {
    ...config,
    testPathIgnorePatterns: [...config.testPathIgnorePatterns, convergenceTestPathPattern],
};
