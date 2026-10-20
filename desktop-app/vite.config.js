import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const srcPath = fileURLToPath(new URL('./src', import.meta.url))

// configs/brand.json is the only place the product name is written (see src/brand.ts).
// The file is edited by hand; drop a BOM that some Windows editors save.
const { brandName } = JSON.parse(readFileSync(new URL('../configs/brand.json', import.meta.url), 'utf8').replace(/^﻿/, ''))
const escapeHtml = value => value.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`)

// Fills index.html's %BRAND_NAME% before Vite's own %ENV% replacement sees it.
const brandNameHtml = () => ({
  name: 'brand-name-html',
  transformIndexHtml: {
    order: 'pre',
    handler: html => html.replaceAll('%BRAND_NAME%', escapeHtml(brandName)),
  },
})

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    brandNameHtml(),
  ],
  resolve: {
    alias: {
      "@": srcPath,
    },
  },
})
