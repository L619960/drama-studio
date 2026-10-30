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
          // 代码分割：vue 生态独立 chunk，便于长期缓存和并行加载。
          // 注意：不要为 element-plus 指定 manualChunks——按包名成 chunk 会把包
          // 入口 index（re-export 全部组件）整块拉入，导致按需引入失效、单个
          // element-plus chunk 膨胀到 2MB+。让 Rollup 依据实际按需引用自动拆分，
          // 各个 el-* 组件只进入使用它的页面 chunk。
          manualChunks: {
            'vue-vendor': ['vue', 'vue-router']
          }
        }
      }
    }
  }
})
