import { createReadStream, existsSync } from 'fs';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

/**
 * Serves the folder of combined game records (see `npm run records`) to the game viewer. Development
 * only: the plugin exists for `vite` serving and never for a build, and only flat `.json` names are read.
 */
function gameRecords(): Plugin {
  const folder = resolve(__dirname, '../game-records');
  return {
    name: 'game-records', apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/game-records', (request, response) => {
        let name = '';
        try { name = decodeURIComponent((request.url ?? '').split('?')[0].replace(/^\//, '')); } catch { /* A malformed name is simply not found. */ }
        const path = resolve(folder, name);
        if (request.method !== 'GET' || !/^[a-z0-9][a-z0-9-]{0,60}\.json$/.test(name) || !existsSync(path)) { response.statusCode = 404; response.end(); return; }
        response.setHeader('Content-Type', 'application/json');
        response.setHeader('Cache-Control', 'no-store');
        createReadStream(path).pipe(response);
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), gameRecords()],
  resolve: {
    alias: {
      '@diplomacy/shared': resolve(__dirname, '../shared/src/index.ts'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/socket.io': {
        target: 'http://localhost:3001',
        ws: true,
      },
      '/api': {
        target: 'http://localhost:3001',
      },
    },
  },
});
