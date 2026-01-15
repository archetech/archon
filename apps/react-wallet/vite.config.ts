import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const port = Number(process.env.VITE_PORT ?? '4228');

export default defineConfig({
    base: './',
    plugins: [react()],
    server: {
        host: true,
        port,
    },
    resolve: {
        alias: {
            "@didcid/cipher/web": path.resolve(__dirname, "../../packages/cipher/dist/esm/cipher-web.js"),
            "@didcid/common/errors": path.resolve(__dirname, "../../packages/common/dist/esm/errors.js"),
            "@didcid/gatekeeper/client": path.resolve(__dirname, "../../packages/gatekeeper/dist/esm/gatekeeper-client.js"),
            "@didcid/gatekeeper/types": path.resolve(__dirname, "../../packages/gatekeeper/dist/types/types.d.js"),
            "@didcid/keymaster/wallet/web": path.resolve(__dirname, "../../packages/keymaster/dist/esm/db/web.js"),
            "@didcid/keymaster/wallet/json-memory": path.resolve(__dirname, "../../packages/keymaster/dist/esm/db/json-memory.js"),
            "@didcid/keymaster/wallet/cache": path.resolve(__dirname, "../../packages/keymaster/dist/esm/db/cache.js"),
            "@didcid/keymaster/wallet/typeGuards": path.resolve(__dirname, "../../packages/keymaster/dist/esm/db/typeGuards.js"),
            "@didcid/keymaster/types": path.resolve(__dirname, "../../packages/keymaster/dist/types/types.d.js"),
            "@didcid/keymaster/search": path.resolve(__dirname, "../../packages/keymaster/dist/esm/search-client.js"),
            "@didcid/keymaster/encryption": path.resolve(__dirname, "../../packages/keymaster/dist/esm/encryption.js"),
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
