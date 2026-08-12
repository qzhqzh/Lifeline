import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    rollupOptions: {
      output: {
        entryFileNames: 'assets/emblem.js',
        assetFileNames: 'assets/emblem.[ext]'
      }
    }
  }
});
