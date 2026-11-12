import React from 'react';
import { createRoot } from 'react-dom/client';
import { ViewerApp } from './viewer/ViewerApp.js';
import './styles.css';

/** The static copy of the game viewer (`npm run viewer:static`): saved games only, no game server behind it. */
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ViewerApp server={false} />
  </React.StrictMode>
);
