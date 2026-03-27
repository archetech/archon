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
    },
    build: {
      outDir: './build',
    },
  };
});
