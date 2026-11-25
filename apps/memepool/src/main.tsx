import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { createApi } from './api';
import { setRoot } from './route';
import 'katex/dist/katex.min.css';
import './styles.css';

// Where the node offers the two services, and the node itself. The defaults
// are Drawbridge's mounts on the host the pages are served from.
const api = createApi({
    memepool: import.meta.env.VITE_MEMEPOOL_URL ?? '/memepool',
    memeplex: import.meta.env.VITE_MEMEPLEX_URL ?? '/memeplex',
    node: import.meta.env.VITE_NODE_URL ?? '',
});

// The pages' files are beside this script's directory, whatever address the
// page was opened at: a link to a publication is a path under theirs.
setRoot(new URL('../', import.meta.url).pathname);

createRoot(document.getElementById('root')!).render(<StrictMode><App api={api} /></StrictMode>);
