import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const port = Number(process.env.VITE_PORT ?? '4225');

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
            "@didcid/cipher/passphrase": path.resolve(__dirname, "../../packages/cipher/dist/esm/passphrase.js"),
            "@didcid/cipher/web": path.resolve(__dirname, "../../packages/cipher/dist/esm/cipher-web.js"),
            "@didcid/gatekeeper/drawbridge": path.resolve(__dirname, "../../packages/gatekeeper/dist/esm/drawbridge-client.js"),
            "@didcid/keymaster/wallet/web": path.resolve(__dirname, "../../packages/keymaster/dist/esm/db/web.js"),
            "@didcid/keymaster/wallet/json-memory": path.resolve(__dirname, "../../packages/keymaster/dist/esm/db/json-memory.js"),
            "@didcid/keymaster/wallet/cache": path.resolve(__dirname, "../../packages/keymaster/dist/esm/db/cache.js"),
            "@didcid/keymaster/wallet/typeGuards": path.resolve(__dirname, "../../packages/keymaster/dist/esm/db/typeGuards.js"),
            "@didcid/keymaster": path.resolve(__dirname, "../../packages/keymaster/dist/esm/keymaster.js"),
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
