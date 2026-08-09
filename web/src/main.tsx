import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';

// PWA: il service worker viene registrato solo in produzione, per non
// interferire con il live-reload dello sviluppo.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => {
      // La dashboard resta pienamente funzionante anche senza service worker.
    });
  });
}

const root = document.getElementById('root');
if (root) {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}