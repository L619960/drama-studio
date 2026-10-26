import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts'
const tts = new MsEdgeTTS()
try {
  await tts.setMetadata('zh-CN-YunjianNeural', OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3)
  const { audio } = tts.toStream('这是一段现代都市台词的清晰男声测试。')
  const chunks = []
  for await (const c of audio) chunks.push(c)
  const buf = Buffer.concat(chunks)
  console.log('EDGE_OK bytes=' + buf.length)
  process.exit(0)
} catch (e) {
  console.log('EDGE_FAIL ' + (e && e.message ? e.message : String(e)).slice(0, 160))
  process.exit(1)
}
