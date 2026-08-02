import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'

// Plugin: serve specific public/ HTML files before the SPA fallback intercepts them.
// This gives /api-docs/ parity with the vercel.json rewrite exclusion in local dev.
function serveStaticHtml(routes) {
  return {
    name: 'serve-static-html',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split('?')[0]
        for (const { prefix, file } of routes) {
          if (url === prefix || url === prefix + 'index.html') {
            const filePath = path.resolve(__dirname, file)
            if (fs.existsSync(filePath)) {
              res.setHeader('Content-Type', 'text/html')
              res.end(fs.readFileSync(filePath, 'utf-8'))
              return
            }
          }
        }
        next()
      })
    },
  }
}

export default defineConfig({
  plugins: [
    react(),
    serveStaticHtml([
      { prefix: '/api-docs/', file: 'public/api-docs/index.html' },
    ]),
  ],
  cacheDir: '.vite-cache',
})
