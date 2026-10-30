import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import type { AppSettings } from '../../src/shared/ipcTypes'
import {
  logLlmError,
  llmBaseUrl
} from '../../src/main/core/llmRequest'

describe('llmRequest · LLM 请求适配层（2026-10-30 补 branches）', () => {
  let dir: string
  let origAppData: string | undefined

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'llmreq-'))
    origAppData = process.env.APPDATA
    process.env.APPDATA = dir
  })
  afterEach(() => {
    process.env.APPDATA = origAppData
    rmSync(dir, { recursive: true, force: true })
  })

  describe('llmBaseUrl：baseURL 解析（纯函数）', () => {
    it('有 baseUrl → 去末尾斜杠', () => {
      expect(llmBaseUrl({ llm: { baseUrl: 'https://api.deepseek.com/' } } as AppSettings))
        .toBe('https://api.deepseek.com')
    })

    it('空 baseUrl → 默认 deepseek 官方端点', () => {
      expect(llmBaseUrl({ llm: { baseUrl: '' } } as AppSettings))
        .toBe('https://api.deepseek.com')
    })

    it('无末尾斜杠 → 原样返回', () => {
      expect(llmBaseUrl({ llm: { baseUrl: 'https://example.com/api' } } as AppSettings))
        .toBe('https://example.com/api')
    })

    it('多个末尾斜杠 → 全部去掉', () => {
      expect(llmBaseUrl({ llm: { baseUrl: 'https://x.com///' } } as AppSettings))
        .toBe('https://x.com')
    })
  })

  describe('logLlmError：错误落盘 + 详情字符串', () => {
    it('正常 HTTP 错误 → 写日志文件 + 返回含状态码的 detail', () => {
      const err = {
        message: 'bad request',
        stack: 'Error: bad request\n  at foo.js:1',
        response: { status: 400, data: { error: 'thinking not supported' } }
      }
      const detail = logLlmError('test-stage', err)
      expect(detail).toContain('HTTP 400')
      expect(detail).toContain('bad request')
      expect(detail).toContain('thinking not supported')

      const logPath = path.join(dir, 'drama-studio', 'llm-error.log')
      expect(existsSync(logPath)).toBe(true)
      const content = readFileSync(logPath, 'utf-8')
      expect(content).toContain('test-stage')
      expect(content).toContain('HTTP 400')
    })

    it('非 HTTP 错误 → detail 无 HTTP 前缀', () => {
      const err = new Error('network unreachable')
      const detail = logLlmError('api', err)
      expect(detail).not.toContain('HTTP')
      expect(detail).toContain('network unreachable')
    })

    it('response.data 是长字符串 → 截 500 字', () => {
      const err = { response: { status: 500, data: 'long error body ' + 'x'.repeat(600) } }
      const detail = logLlmError('api', err)
      // 500 字截断 + 其他部分，长度应该 < 600
      expect(detail.length).toBeLessThan(600)
    })

    it('response.data 是对象 → JSON.stringify 后截 500', () => {
      const err = { response: { status: 500, data: { error: 'timeout', detail: { x: 1 } } } }
      const detail = logLlmError('api', err)
      expect(detail).toContain('HTTP 500')
      expect(detail).toContain('timeout')
    })

    it('response.data 是 null → 不崩', () => {
      const err = { response: { status: 500, data: null } }
      const detail = logLlmError('api', err)
      expect(detail).toContain('HTTP 500')
    })

    it('纯 string error → String(err) fallback', () => {
      const detail = logLlmError('api', 'just a string error')
      expect(detail).toContain('just a string error')
      expect(detail).not.toContain('HTTP')
    })

    it('error 是 null/undefined → 不崩', () => {
      const detail = logLlmError('api', null)
      expect(typeof detail).toBe('string')
    })

    it('落盘后追加而非覆盖（多次调用 → 多行）', () => {
      logLlmError('stage1', new Error('err1'))
      logLlmError('stage2', new Error('err2'))
      const logPath = path.join(dir, 'drama-studio', 'llm-error.log')
      const content = readFileSync(logPath, 'utf-8')
      expect(content).toContain('stage1')
      expect(content).toContain('stage2')
    })

    it('response.status 是 undefined → detail 里无 HTTP 前缀', () => {
      const err = { message: 'boom', response: {} }
      const detail = logLlmError('api', err)
      expect(detail).not.toContain('HTTP')
      expect(detail).toContain('boom')
    })
  })
})
