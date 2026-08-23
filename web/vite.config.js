import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port:process.env.PORT ?? 5173,
    // Only used by `npm run dev` outside Docker. In Compose, Nginx does this.
    proxy: {
      '/api': 'http://localhost:4000',
    },
  },
});
