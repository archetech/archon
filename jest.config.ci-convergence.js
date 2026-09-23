import config, { convergenceTestPathPattern } from './jest.config.js';

export default {
    ...config,
    testRegex: convergenceTestPathPattern,
};
