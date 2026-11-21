import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

export default mergeConfig(viteConfig, defineConfig({
    test: {
        environment: 'jsdom',
        include: ['src/**/*.test.tsx', 'src/**/*.test.ts'],
        setupFiles: ['./src/test/setup.ts'],
        testTimeout: 15_000,
    },
}));
