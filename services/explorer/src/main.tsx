import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.js';
import { BrowserRouter } from 'react-router-dom';
import './static/index.css';
import { loadRuntimeConfig } from './runtimeConfig.js';

// Vite bakes the base in at build time; the router has to agree with it or deep
// links resolve against the wrong root when the app is served under a prefix.
const basename = import.meta.env.BASE_URL.replace(/\/$/, '');

const rootElement = document.getElementById('root') as HTMLElement;
const root = ReactDOM.createRoot(rootElement);

function render() {
    root.render(
        <React.StrictMode>
            <BrowserRouter basename={basename}>
                <App />
            </BrowserRouter>
        </React.StrictMode>
    );
}

// Resolve the backend URLs before first paint, so nothing fires a request at the
// build-time default and then re-fires at the real one. Not a top-level await:
// the build target (es2020) does not support it.
loadRuntimeConfig().then(render).catch(render);
