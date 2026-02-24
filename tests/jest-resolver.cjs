const path = require('path');
const fs = require('fs');

module.exports = (request, options) => {
    // For .js imports within the l402 package source, try .ts
    if (request.endsWith('.js') && options.basedir && options.basedir.includes('packages/l402/src')) {
        const tsPath = request.replace(/\.js$/, '.ts');
        const resolved = path.resolve(options.basedir, tsPath);
        if (fs.existsSync(resolved)) {
            return resolved;
        }
    }

    // Default resolution
    return options.defaultResolver(request, options);
};
