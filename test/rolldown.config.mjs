import { fileURLToPath } from 'node:url'
import path from 'node:path'

// 打包独立编排脚本：alias electron → stub，node_modules 全部 external
export default {
  input: {
    'run-director': path.resolve('test/run-director-entry.ts'),
    'run-director-smoke': path.resolve('test/run-director-smoke-entry.ts'),
    'run-mixbgm-check': path.resolve('test/run-mixbgm-check-entry.ts'),
    'run-pipeline': path.resolve('test/run-pipeline-entry.ts'),
    'run-h3-smoke': path.resolve('test/run-h3-smoke-entry.ts'),
    'run-conversation-smoke': path.resolve('test/run-conversation-smoke-entry.ts'),
    'run-h3-queue-smoke': path.resolve('test/run-h3-queue-smoke-entry.ts')
  },
  output: {
    dir: path.resolve('test/dist'),
    format: 'cjs',
    entryFileNames: '[name].cjs',
    chunkFileNames: '[name].cjs' // package.json 为 type:module，.js 会被当作 ESM，共享 chunk 也必须 .cjs
  },
  resolve: {
    extensions: ['.ts', '.js', '.cjs'],
    alias: {
      electron: fileURLToPath(new URL('./stub-electron.cjs', import.meta.url))
    }
  },
  external: [/^node:/, 'axios', 'fluent-ffmpeg', 'ffmpeg-static', 'ffprobe-static', 'msedge-tts', 'ws', /^@xenova\/transformers/, /^onnxruntime-/]
}
