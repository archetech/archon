import config, { convergenceTestPathPattern } from './jest.config.js';

const convergenceConfig = {
    ...config,
    testRegex: convergenceTestPathPattern,
};

export default convergenceConfig;
