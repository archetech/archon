import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App.js';

const rootElement = document.getElementById('root');
if (!rootElement) {
    throw new Error("Root element #root not found");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
