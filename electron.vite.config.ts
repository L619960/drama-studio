import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'node:path'
import { visualizer } from 'rollup-plugin-visualizer'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts')
        },
        output: {
          // sandbox 模式（main/index.ts I-5）下 Electron 仅支持 CommonJS preload，
          // package.json "type": "module" 会默认输出 ESM(.mjs) 导致 preload 加载失败、
          // window.api 未挂载（打包版 LLM/ComfyUI 全部"连不上"的根因），强制输出 .cjs
          format: 'cjs',
          entryFileNames: '[name].cjs'
        }
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@': resolve('src/renderer/src')
      }
    },
    plugins: [
      vue(),
      // Element Plus 按需引入：模板里的 el-* 组件自动按需注册并注入对应样式，
      // 避免 app.use(ElementPlus) 全量打包（renderer 体积 54% 来自 element-plus）。
      // 程序化组件（ElMessage/ElMessageBox/ElLoading）样式在 renderer/src/main.ts 手动引入。
      Components({
        resolvers: [ElementPlusResolver()]
      }),
      // 包体积分析：仅当 ANALYZE=1 时生成 renderer-stats.html，不影响常规 build
      ...(process.env.ANALYZE
        ? [
            visualizer({
              filename: 'out/renderer-stats.html',
              open: false,
              gzipSize: true,
              brotliSize: true
            })
          ]
        : [])
    ],
    build: {
      rollupOptions: {
        output: {
          // 代码分割：
          // 1) 入口共享块只保留应用代码；把跨页面共享的第三方库按包拆成独立 vendor chunk，
          //    便于长期缓存与并行加载（App 每次改动不会让整个 vendor 失效）。
          // 2) element-plus 组件本体不做整包分组——整包成 chunk 会把包入口（re-export 全部
          //    组件）整块拉入，按需引入失效、单 chunk 膨胀到 2MB+；交给 Rollup 依据实际
          //    引用按页面拆分（el-table-column 等只进入使用它的页面 chunk）。
          manualChunks(id) {
            if (!id.includes('node_modules')) return undefined
            if (id.includes('/@element-plus/icons-vue/')) return 'icons-vendor'
            if (id.includes('/element-plus/')) return undefined
            if (id.includes('/@vueuse/')) return 'vueuse-vendor'
            if (id.includes('/@popperjs/')) return 'popper-vendor'
            if (id.includes('/@ctrl/tinycolor/')) return 'color-vendor'
            if (id.includes('/dayjs/')) return 'date-vendor'
            if (id.includes('/lodash-es/')) return 'lodash-vendor'
            if (id.includes('/@vue/') || id.includes('/vue/') || id.includes('/vue-router/')) return 'vue-vendor'
            return undefined
          }
        }
      }
    }
  }
})
