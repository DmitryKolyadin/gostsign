import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// GitHub Pages отдаёт проект по /<repo>/ — базовый путь задаёт CI через GHPAGES_BASE.
export default defineConfig({
  base: process.env.GHPAGES_BASE ?? '/',
  plugins: [react()],
})
