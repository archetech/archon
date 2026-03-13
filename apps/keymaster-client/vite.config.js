import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const port = Number(process.env.VITE_PORT ?? '4227');

export default defineConfig({
    base: './',
    plugins: [react()],
    server: {
        host: true,
        port,
        allowedHosts: true,
    },
    resolve: {
        alias: {
            "@didcid/keymaster/client": path.resolve(__dirname, "../../packages/keymaster/dist/esm/keymaster-client.js"),
            buffer: 'buffer',
        }
    },
    optimizeDeps: {
        include: ['buffer'],
    },
    build: {
        sourcemap: true,
        outDir: 'dist',
        chunkSizeWarningLimit: 2000,
        rollupOptions: {
            input: {
                index: path.resolve(__dirname, 'index.html')
            }
        }
    }
});
