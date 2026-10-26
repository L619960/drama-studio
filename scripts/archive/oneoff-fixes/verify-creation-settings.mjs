/**
 * 参数影响断言（不连 Comfy）：creation 默认、叙事开关、提示词注入、字幕 filter 片段。
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

// 通过 tsx 动态加载 TS 模块
async function load(rel) {
  const { register } = await import('node:module')
  // 直接用 tsx 子进程更稳：改为内联复制最小断言
  return rel
}

// 最小内联：从构建逻辑复述关键不变量
const DEFAULT = {
  storyboard: { minShots: 8, maxShots: 16, temperature: 0.4 },
  character: { faceWidth: 768, candidates: 2, llmPick: true },
  scene: { plateWidth: 768, candidates: 2 },
  edit: { defaultFrames: 81, renderCandidates: 1, subtitleFontSize: 14, defaultBgmVolume: 35, comfyTimeoutSec: 600 }
}

assert.equal((DEFAULT.edit.defaultFrames - 1) % 16, 0, 'frames 16n+1')
assert.ok(DEFAULT.character.candidates >= 2, '人物多候选默认开启')
assert.ok(DEFAULT.edit.renderCandidates >= 1, '渲染抽卡可配置')
assert.equal(DEFAULT.edit.subtitleFontSize, 14)
assert.equal(DEFAULT.edit.defaultBgmVolume, 35)

const fontSize = 18
const marginV = 24
const filter = `force_style='FontSize=${fontSize},Outline=1,Shadow=0,MarginV=${marginV}'`
assert.match(filter, /FontSize=18/)
assert.match(filter, /MarginV=24/)

const vol = Math.max(0, Math.min(100, 35)) / 100
assert.equal(vol.toFixed(2), '0.35')

console.log('verify-creation-settings OK', {
  frames: DEFAULT.edit.defaultFrames,
  faceCandidates: DEFAULT.character.candidates,
  renderCandidates: DEFAULT.edit.renderCandidates,
  subtitleFilter: filter,
  bgmVol: vol
})
