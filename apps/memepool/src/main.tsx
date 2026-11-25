import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { createApi } from './api';
import 'katex/dist/katex.min.css';
import './styles.css';

// Where the node offers the two services, and the node itself. The defaults
// are Drawbridge's mounts on the host the pages are served from.
const api = createApi({
    memepool: import.meta.env.VITE_MEMEPOOL_URL ?? '/memepool',
    memeplex: import.meta.env.VITE_MEMEPLEX_URL ?? '/memeplex',
    node: import.meta.env.VITE_NODE_URL ?? '',
});

createRoot(document.getElementById('root')!).render(<StrictMode><App api={api} /></StrictMode>);
