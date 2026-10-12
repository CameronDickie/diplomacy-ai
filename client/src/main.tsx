import React from 'react';
import { createRoot } from 'react-dom/client';
import { AuthProvider } from './hooks/useAuth.js';
import { App } from './ui/App.js';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AuthProvider>
      <App />
    </AuthProvider>
  </React.StrictMode>
);
