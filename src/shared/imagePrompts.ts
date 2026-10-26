/**
 * 电影工业级资产提示词（定妆 / 三视图 / 场景板 / 首尾帧 / 图生视频）。
 * 标准对齐短剧竖屏制作：写实摄影、锁定身份、规范镜头语言、压制塑料美颜与换装漂移。
 *
 * 本文件已按域拆分到 src/shared/ 下的子模块，此处仅作 re-export 枢纽，
 * 保持全部历史具名导出路径（src/shared/imagePrompts）不变：
 *  - promptConstants  纯常量（画质/负向/景别/质量块）
 *  - promptUtils      拼装原子（joinParts / mergeNegative）
 *  - motion           动作清洗 / 中文→英文动作 cue / 动作判定正则 / 工作流选型
 *  - castAppearance   定妆外观清洗 / 发型服装抽取 / 身份硬锁 / OOC 服装清洗
 *  - promptDrift      身份漂移 / 提示词中毒检测与修复 / 空镜认领 / 分镜对齐
 *  - negatives        视频/场景/定妆负向与写实锁
 *  - promptStrips     文本净化（虚词/对戏从句/户外暗示/拟音词/召唤词）
 *  - scenePrompts     定妆/三视图/场景板/首尾帧/图生视频动作提示组装
 */

export * from './promptConstants'
// joinParts 为跨模块内部拼装原子，非历史公开导出，不从此枢纽泄漏
export { mergeNegative } from './promptUtils'
export * from './motion'
export * from './castAppearance'
export * from './promptDrift'
export * from './negatives'
export * from './promptStrips'
export * from './scenePrompts'
