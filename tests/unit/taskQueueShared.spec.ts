import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  readImageSize,
  toPercent,
  CANCEL_ERROR,
  LORA_T2V_TURBO,
  LORA_R2V_TURBO
} from '../../src/main/core/taskQueueShared'

describe('taskQueueShared · 队列辅助函数（2026-10-30 补覆盖率）', () => {
  let dir: string

  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'tqs-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  describe('toPercent：设置页 50-200 转 msedge-tts 百分比', () => {
    it('100 → +0%', () => { expect(toPercent(100)).toBe('+0%') })
    it('150 → +50%', () => { expect(toPercent(150)).toBe('+50%') })
    it('50 → -50%', () => { expect(toPercent(50)).toBe('-50%') })
    it('200 → +100%', () => { expect(toPercent(200)).toBe('+100%') })
    it('0 → -100%', () => { expect(toPercent(0)).toBe('-100%') })
    it('101 → +1%', () => { expect(toPercent(101)).toBe('+1%') })
    it('100.4 → +0%（round）', () => { expect(toPercent(100.4)).toBe('+0%') })
    it('100.5 → +1%（round）', () => { expect(toPercent(100.5)).toBe('+1%') })
  })

  describe('常量导出', () => {
    it('CANCEL_ERROR 为 "__CANCELLED__"', () => {
      expect(CANCEL_ERROR).toBe('__CANCELLED__')
    })
    it('LoRA 常量为非空字符串', () => {
      expect(LORA_T2V_TURBO.length).toBeGreaterThan(0)
      expect(LORA_R2V_TURBO.length).toBeGreaterThan(0)
    })
  })

  describe('readImageSize：读 PNG/JPEG 尺寸（纯 Node Buffer 解析）', () => {
    it('不存在的文件 → null', () => {
      expect(readImageSize('/nonexistent/path.png')).toBeNull()
    })

    it('非图片文件 → null', () => {
      const f = `${dir}/fake.txt`
      writeFileSync(f, 'hello world')
      expect(readImageSize(f)).toBeNull()
    })

    it('空文件 → null', () => {
      const f = `${dir}/empty.png`
      writeFileSync(f, Buffer.alloc(0))
      expect(readImageSize(f)).toBeNull()
    })

    it('PNG：构造合法 1x1 PNG → 读出尺寸', () => {
      const f = `${dir}/test.png`
      // 最小 PNG：signature + IHDR chunk
      // PNG signature = 8 bytes
      const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      // IHDR: length=13, type=IHDR, data=width(4), height(4), bit(1), color(1), comp(1), filter(1), interlace(1), crc(4)
      const ihdr = Buffer.alloc(25)
      ihdr.writeUInt32BE(13, 0)          // length
      ihdr.write('IHDR', 4)              // type
      ihdr.writeUInt32BE(640, 8)         // width
      ihdr.writeUInt32BE(480, 12)        // height
      // 其他字段留零，CRC 也留零——虽然 CRC 不对但 readImageSize 只看 signature 和前几个字节
      writeFileSync(f, Buffer.concat([sig, ihdr]))
      const v = readImageSize(f)
      expect(v).toEqual({ width: 640, height: 480 })
    })

    it('JPEG：构造 SOF0 marker → 读出尺寸', () => {
      const f = `${dir}/test.jpg`
      // JPEG SOI marker + APP0 占位 + SOF0
      // SOI = FF D8
      const soi = Buffer.from([0xff, 0xd8])
      // SOF0 = FF C0 + length(2) + precision(1) + height(2) + width(2) + components(1)
      const sof = Buffer.alloc(10)
      sof[0] = 0xff; sof[1] = 0xc0        // marker
      sof.writeUInt16BE(8, 2)             // length
      sof[4] = 8                          // precision
      sof.writeUInt16BE(300, 5)           // height
      sof.writeUInt16BE(400, 7)           // width
      sof[9] = 1                          // components
      // EOI = FF D9
      const eoi = Buffer.from([0xff, 0xd9])
      writeFileSync(f, Buffer.concat([soi, sof, eoi]))
      const v = readImageSize(f)
      expect(v).toEqual({ width: 400, height: 300 })
    })

    it('JPEG 其他 marker（非 SOF）→ 跳过直到 SOF', () => {
      const f = `${dir}/test2.jpg`
      const soi = Buffer.from([0xff, 0xd8])
      // APP1 marker 占位（FF E1）
      const app1 = Buffer.alloc(10)
      app1[0] = 0xff; app1[1] = 0xe1
      app1.writeUInt16BE(8, 2)
      // SOF0
      const sof = Buffer.alloc(10)
      sof[0] = 0xff; sof[1] = 0xc0
      sof.writeUInt16BE(8, 2)
      sof[4] = 8
      sof.writeUInt16BE(500, 5)
      sof.writeUInt16BE(700, 7)
      sof[9] = 1
      const eoi = Buffer.from([0xff, 0xd9])
      writeFileSync(f, Buffer.concat([soi, app1, sof, eoi]))
      const v = readImageSize(f)
      expect(v).toEqual({ width: 700, height: 500 })
    })
  })
})
