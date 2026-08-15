import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, process.cwd(), '');

    return {
        plugins: [react()],
        root: './',
        // Served under a path prefix so Drawbridge can expose it publicly on the
        // node's own host. Vite bakes this in, so the image is prefix-specific;
        // server.js mounts the app at the same prefix, which keeps direct access
        // on port 4000 and proxied access byte-identical.
        base: env.VITE_EXPLORER_BASE || '/explorer/',
        server: {
            port: parseInt(env.VITE_EXPLORER_PORT) || 4000,
        },
        build: {
            outDir: './dist',
        },
    };
});
