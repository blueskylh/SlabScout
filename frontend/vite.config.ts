import viteErrorReporter from "./.vulcan-error-reporter.js";
import path from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig(() => {
  const frontendPort = Number.parseInt(process.env.PORT || '', 10)
  const backendPort = Number.parseInt(process.env.BACKEND_PORT || '', 10)
  const base = process.env.BASE_PATH || './'
  const hasAbsBase = base.startsWith('/')
  const apiBasePrefix = hasAbsBase ? base.replace(/\/$/, '') : ''

  const backendProxy = {
    target: `http://127.0.0.1:${backendPort}`,
    changeOrigin: true,
    ...(hasAbsBase && {
      rewrite: (requestPath: string) => requestPath.replace(base, '/'),
    }),
  }

  return {
    cacheDir: process.env.VITE_CACHE_DIR || 'node_modules/.vite',
    plugins: [
      viteErrorReporter({ vulcanDir: "/workspaces/.vulcan" }),react(), tailwindcss()],
    server: {
      allowedHosts: true,
      host: '0.0.0.0',
      port: frontendPort || undefined,
      proxy: {
        [`${apiBasePrefix}/api`]: backendProxy,
      },
      hmr: {
        path: 'ws/vite-hmr',
      },
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
      dedupe: ['react', 'react-dom'],
      preserveSymlinks: true,
    },
    optimizeDeps: {
      include: [
        'react',
        'react-dom',
        'react-dom/client',
        'react/jsx-dev-runtime',
        'react/jsx-runtime',
        '@tanstack/react-query',
        '@tanstack/query-core',
      ],
    },
    build: {
      // ECharts is intentionally lazy-loaded as a separate visualization chunk.
      // Keep the warning threshold realistic for that vendor payload while the
      // interactive app shell remains small.
      chunkSizeWarningLimit: 1200,
      rollupOptions: {
        output: {
          manualChunks(id: string) {
            if (id.includes('node_modules/echarts') || id.includes('node_modules/zrender') || id.includes('node_modules/echarts-for-react')) return 'charts'
            if (id.includes('node_modules/lucide-react')) return 'icons'
            if (id.includes('node_modules/@tanstack')) return 'query'
            if (id.includes('node_modules/react')) return 'react-vendor'
          },
        },
      },
    },
    base,
  }
})
