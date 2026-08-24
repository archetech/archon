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
        // @didcid/keymaster-ui is consumed as source from outside this app, so its
        // bare imports resolve upward from packages/ and would otherwise load the
        // copies npm installs at the root for its peerDependencies -- a second
        // React and a second MUI, which is both wrong and 25% more bundle.
        dedupe: ["@mui/material", "@mui/icons-material", "@emotion/react", "@emotion/styled", "qrcode.react", "axios", "react", "react-dom"],
        alias: {
            "@didcid/keymaster-ui/App.css": path.resolve(__dirname, "../../packages/keymaster-ui/src/App.css"),
            "@didcid/keymaster-ui": path.resolve(__dirname, "../../packages/keymaster-ui/src/index.js"),
            "@didcid/clients/keymaster": path.resolve(__dirname, "../../packages/clients/dist/esm/keymaster-client.js"),
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
