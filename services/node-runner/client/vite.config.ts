import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the client runs on Vite and the API on the server's port.
const apiTarget = process.env.NODE_RUNNER_API ?? 'http://127.0.0.1:4280';

export default defineConfig({
    plugins: [react()],
    server: {
        port: 4281,
        proxy: {
            '/api': { target: apiTarget, changeOrigin: false },
        },
    },
});
