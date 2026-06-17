import React from 'react';
import { createRoot } from 'react-dom/client';
import { AuthGate } from './ui/AuthGate.js';
import { App } from './ui/App.js';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AuthGate>
      <App />
    </AuthGate>
  </React.StrictMode>
);
