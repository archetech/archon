import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

export default mergeConfig(viteConfig, defineConfig({
    test: {
        environment: 'jsdom',
        include: ['src/**/*.test.tsx', 'src/**/*.test.ts'],
        setupFiles: ['./src/test/setup.ts'],
        testTimeout: 15_000,
        // Merged into the repository's report by the unit-test workflow. Every
        // source file is listed, so one no test reaches counts as 0% and is
        // not left out. `main.tsx` only mounts the app.
        coverage: {
            provider: 'istanbul',
            include: ['src/**/*.{ts,tsx}'],
            exclude: ['src/test/**', 'src/main.tsx', 'src/**/*.d.ts'],
            reporter: ['json', 'text-summary'],
            reportsDirectory: './coverage',
        },
    },
}));
