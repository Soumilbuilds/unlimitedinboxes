import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000'
    }
  },
  define: {
    'import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY': JSON.stringify(
      'pk_live_51TXFGYAxRfptSO4wkESkYbJULJfUNAc6B2Y7p1Io5gFxMFy1i2qPuhXbs19YeHU5duPTEflZzn2P5m9aPkNZpSzX00jQnvph3v'
    ),
  },
});
