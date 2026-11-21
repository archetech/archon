import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The pages are served under whatever path the node gives them, so their own
// files are found relative to the page.
export default defineConfig({
    base: './',
    plugins: [react()],
});
