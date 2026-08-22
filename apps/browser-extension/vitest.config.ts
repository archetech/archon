import { defineConfig } from 'vitest/config';
import path from 'node:path';

// The extension builds with webpack, which vitest cannot read, so the package
// aliases are restated here from webpack.common.js.
//
// One difference that matters: webpack marks an exact alias with a trailing
// `$`, and vite has no such thing -- its object aliases are ordered prefix
// matches, first hit wins. So the specific subpaths must come BEFORE the bare
// package they extend, or "@didcid/keymaster/didcomm-protocols" is rewritten
// into the keymaster bundle. Copying the `$` across silently matches nothing.
const packages = path.resolve(__dirname, '../../packages');

export default defineConfig({
    // packages/wallet-ui has no tsconfig of its own, so esbuild finds no `jsx`
    // setting for its files and falls back to the classic transform, which needs
    // React in scope. The webpack build avoids this through babel; saying it
    // here keeps the test path independent of that.
    esbuild: { jsx: 'automatic' },
    resolve: {
        // wallet-ui is consumed as source from outside this app, so without
        // this its imports resolve to the copies npm installs at the root for
        // its peerDependencies rather than to this app's. Listing them here
        // makes resolution happen from the app root, which is what keeps a
        // single copy of React and MUI in play -- two MUI instances means two
        // emotion caches. Same list the react-wallet vite config carries, and
        // the counterpart of webpack's `resolve.modules`.
        dedupe: ['@mui/lab', 'qrcode.react', '@uiw/react-json-view', '@mui/material', '@mui/icons-material', '@emotion/react', '@emotion/styled', 'react', 'react-dom'],
        alias: {
            '@didcid/wallet-ui': path.join(packages, 'wallet-ui/src/index.ts'),
            '@didcid/cipher/web': path.join(packages, 'cipher/dist/esm/cipher-web.js'),
            '@didcid/cipher/passphrase': path.join(packages, 'cipher/dist/esm/passphrase.js'),
            '@didcid/common/errors': path.join(packages, 'common/dist/esm/errors.js'),
            '@didcid/clients/gatekeeper': path.join(packages, 'clients/dist/esm/gatekeeper-client.js'),
            '@didcid/keymaster/wallet/chrome': path.join(packages, 'keymaster/dist/esm/db/chrome.js'),
            '@didcid/keymaster/wallet/json-memory': path.join(packages, 'keymaster/dist/esm/db/json-memory.js'),
            '@didcid/keymaster/wallet/cache': path.join(packages, 'keymaster/dist/esm/db/cache.js'),
            '@didcid/keymaster/wallet/typeGuards': path.join(packages, 'keymaster/dist/esm/db/typeGuards.js'),
            '@didcid/keymaster/search': path.join(packages, 'keymaster/dist/esm/search-client.js'),
            '@didcid/keymaster/didcomm-protocols': path.join(packages, 'keymaster/dist/esm/didcomm-protocols.js'),
            // After every subpath above, never before them.
            '@didcid/keymaster': path.join(packages, 'keymaster/dist/esm/keymaster.js'),

        },
    },
    test: {
        environment: 'jsdom',
        include: ['src/**/*.test.tsx', 'src/**/*.test.ts'],
        setupFiles: ['./src/test/setup.ts'],
        testTimeout: 15000,
    },
});
