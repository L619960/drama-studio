// 临时：把 YuNet + ArcFace 预下载到运行时 userData/.models，让后续渲染不再等下载
const path = require('node:path')
const fs = require('node:fs')
const { TaskQueue } = require('./dist/taskQueue.cjs')

const DATA_ROOT = 'C:\\Users\\蒋奎\\AppData\\Roaming\\drama-studio\\drama-studio'
;(async () => {
  const queue = new TaskQueue(DATA_ROOT, {}, {}, {}, {}, {}, {})
  const service = queue['getConsistencyService']()
  const fd = service['faceDetector']
  const modelDir = fd['modelDir']
  console.log('runtime model dir:', modelDir)
  fs.mkdirSync(modelDir, { recursive: true })

  const ok1 = await fd.available()
  console.log('YuNet available():', ok1)
  const ok2 = await fd.recognitionAvailable()
  console.log('ArcFace recognitionAvailable():', ok2)

  console.log('\n--- 文件清单 ---')
  for (const f of ['yunet.onnx', 'w600k_mbf.onnx', 'face-detect-worker.cjs']) {
    const p = path.join(modelDir, f)
    if (fs.existsSync(p)) {
      console.log(`${f}: ${(fs.statSync(p).size/1024).toFixed(1)} KB`)
    } else {
      console.log(`${f}: MISSING`)
    }
  }
  process.exit(0)
})().catch(e => { console.error(e); process.exit(1) })
