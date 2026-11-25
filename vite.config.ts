import tailwindcss from '@tailwindcss/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import react from '@vitejs/plugin-react';
import { nitro } from 'nitro/vite';
import path from 'path';
import { defineConfig } from 'vite';

export default defineConfig(({ command }) => {
  if (command === 'build' && process.env.NODE_ENV === 'development') {
    process.env.NODE_ENV = 'production';
  }

  return {
    plugins: [
      tailwindcss(),
      tanstackStart(),
      nitro({
        compatibilityDate: '2025-07-15',
        inlineDynamicImports: true,
        vercel: {
          functionRules: {
            '/api/mirror': {
              maxDuration: 'max',
            },
          },
        },
      }),
      react(),
    ],
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname, 'src'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
