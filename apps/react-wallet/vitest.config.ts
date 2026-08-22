import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

// Extends the app's own vite config rather than restating it, so the fifteen
// package aliases and the React/MUI dedupe list apply here exactly as they do
// in a real build. Restating them is how a render test ends up loading a second
// copy of React and failing for a reason that has nothing to do with the app.
export default mergeConfig(viteConfig, defineConfig({
    // packages/wallet-ui has no tsconfig of its own, so esbuild finds no `jsx`
    // setting for its files and falls back to the classic transform -- which
    // needs React in scope and throws "React is not defined" the moment one of
    // its components renders. The real builds avoid this because
    // @vitejs/plugin-react babel-transforms them; saying it explicitly here
    // keeps the test path from depending on that.
    esbuild: { jsx: 'automatic' },
    resolve: {
        alias: {
            // The app aliases `buffer` to the browser polyfill, whose Buffer is
            // not the Uint8Array that @noble/hashes accepts once bip39 hands a
            // seed to the HD key derivation -- it fails with "Uint8Array
            // expected" before a wallet can be created. Under Node the native
            // Buffer already is one, so the polyfill is only in the way here.
            buffer: 'node:buffer',
        },
    },
    test: {
        environment: 'jsdom',
        include: ['src/**/*.test.tsx', 'src/**/*.test.ts'],
        setupFiles: ['./src/test/setup.ts'],
        // These mount real provider trees; a hang should fail rather than sit.
        testTimeout: 15000,
    },
}));
