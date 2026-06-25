import React from 'react';
import { createRoot } from 'react-dom/client';
import { AuthGate } from './ui/AuthGate.js';
import { AuthProvider } from './hooks/useAuth.js';
import { App } from './ui/App.js';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AuthProvider>
      <AuthGate>
        <App />
      </AuthGate>
    </AuthProvider>
  </React.StrictMode>
);
