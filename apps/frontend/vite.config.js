import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Panel mobile-first. La URL del backend se inyecta con VITE_API_URL (Vercel/entorno).
export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
});
