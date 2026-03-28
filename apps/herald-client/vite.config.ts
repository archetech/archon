import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, process.cwd(), '');
    const port = parseInt(env.VITE_PORT || env.ARCHON_HERALD_CLIENT_PORT || '4231', 10);

    return {
        base: '/',
        plugins: [react()],
        server: {
            port,
        },
        preview: {
            port,
            // Herald client is typically published behind a reverse proxy on a public domain.
            // Host validation is handled at that layer, so preview must accept forwarded hosts.
            allowedHosts: true,
        },
        build: {
            outDir: './build',
        },
    };
});
