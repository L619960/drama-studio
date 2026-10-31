import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { IpcChannels, type AppSettings } from '../../shared/ipcTypes'
import { faceCastingPrompt, scenePlatePrompt, sceneNegativeFor } from '../../shared/imagePrompts'
import { handleIpc, resolveInsideRoot, toAppFileUrl } from './shared'
import type { SettingsStore } from '../core/settingsStore'
import type { ComfyUIClient } from '../core/comfyuiClient'
import type { ImageService } from '../core/imageService'

export interface SettingsIpcCtx {
  settingsStore: SettingsStore
  comfyuiClient: ComfyUIClient
  imageService: ImageService
}

/** R-02：清掉同类型旧预览图，只保留最新一张（设置预览产物不无限累积） */
async function cleanupPreviewFiles(kind: 'character' | 'scene', keepRel: string): Promise<void> {
  const dir = resolveInsideRoot('preview')
  const entries = await fs.readdir(dir).catch(() => [] as string[])
  const prefix = kind === 'character' ? 'character_' : 'scene_'
  await Promise.all(
    entries
      .filter(f => f.startsWith(prefix) && f.endsWith('.png') && `preview/${f}` !== keepRel)
      .map(f => fs.rm(join(dir, f), { force: true }).catch(() => undefined))
  )
}

export function registerSettingsIpc(ctx: SettingsIpcCtx): void {
  // Settings
  handleIpc(IpcChannels.settingsGet, () => ctx.settingsStore.get())
  handleIpc(IpcChannels.settingsSave, async (_, settings: AppSettings) => {
    const revision = await ctx.settingsStore.save(settings)
    // ComfyUI 地址变更时运行时重连
    if (settings.comfyui?.baseUrl) {
      ctx.comfyuiClient.setBaseUrl(settings.comfyui.baseUrl).catch(() => {})
    }
    // P2-14：把新版本号回传渲染层，供下次保存做乐观并发校验
    return revision
  })
  handleIpc(IpcChannels.settingsPreviewAsset, async (_, input: { kind: 'character' | 'scene'; promptHint: string }) => {
    const s = await ctx.settingsStore.get()
    const c = s.creation
    const stamp = Date.now()
    const rel = input.kind === 'character'
      ? `preview/character_${stamp}.png`
      : `preview/scene_${stamp}.png`
    const abs = resolveInsideRoot(rel)
    if (input.kind === 'character') {
      const ch = c.character
      const look = input.promptHint?.trim() || 'chinese woman in her mid 20s, natural matte skin, long black hair, white hanfu robe with jade hairpin'
      await ctx.imageService.generate(
        faceCastingPrompt(look, { realismLock: ch.realismLock }),
        abs,
        {
          width: ch.faceWidth,
          height: ch.faceHeight,
          workflowName: ch.t2iWorkflow || undefined,
          seed: ch.seedMode === 'fixed' ? ch.seed : undefined,
          negative: sceneNegativeFor(ch.realismLock),
          timeoutMs: Math.max(60, c.edit.comfyTimeoutSec) * 1000
        }
      )
    } else {
      const sc = c.scene
      const scene = input.promptHint?.trim() || 'moody cinematic night atmosphere, era-consistent backdrop'
      await ctx.imageService.generate(
        scenePlatePrompt(scene, undefined, {
          weatherHint: sc.weatherHint,
          emptyStrict: sc.emptyStrict
        }),
        abs,
        {
          width: sc.plateWidth,
          height: sc.plateHeight,
          timeoutMs: Math.max(60, c.edit.comfyTimeoutSec) * 1000
        }
      )
    }
    // R-02：预览产物只留最新一张
    await cleanupPreviewFiles(input.kind, rel).catch(() => undefined)
    return { relativePath: rel, mediaUrl: toAppFileUrl(rel) }
  })
}
