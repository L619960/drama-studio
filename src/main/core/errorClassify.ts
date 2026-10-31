/**
 * 瞬时故障分类：网络抖动 / 服务过载 / 超时类错误可安全自动重试，
 * 永久性错误（缺模型、参数非法、内容拦截）重试无意义，应立即暂停交人工处理。
 * directorAgent（阶段级 LLM 调用）与 taskQueue（单镜渲染）共用同一份判定。
 */
import type { ErrorKind } from '../../shared/ipcTypes'

const TRANSIENT_RE = [
  'etimedout',
  'timeout of \\d+',           // axios："timeout of 60000ms exceeded"
  'timeout after \\d+',        // ComfyUI waitForCompletion："Prompt … timeout after Ns"
  'econnrefused',
  'econnreset',
  'econnaborted',
  'epipe',
  'socket hang up',
  'connection (closed|error|lost|terminated)',
  'network error',
  'fetch failed',
  'status code 4(29|0[89])',   // 429 限流 / 408 超时 / 409 冲突
  'status code 5\\d\\d',       // 5xx 服务端异常
  'queue full',
  '\\bbusy\\b',
  '服务繁忙',
  '请求超时',
  'websocket is not open',
  'ws not connected',
  // 中文瞬时故障（TTS 流式合成/网络层常见）：连接关闭、断开、中断、重置、超时、流中断
  '连接.*(关闭|断开|中断|失败|超时|重置|丢失)',
  '流式.*(中断|关闭|超时|失败)',
  '音频.*(截断|中断)',
  'turn\\.end'
].join('|')

const TRANSIENT = new RegExp(TRANSIENT_RE, 'i')

export function isTransientError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return TRANSIENT.test(msg)
}

/** 显存/分配失败（与瞬时故障互斥处理：走降档而非纯重试） */
export function isOomError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  // outofmemory：兼容 torch.OutOfMemoryError 类名（类名无空格，'out of memory' 匹配不到）
  return /out of memory|outofmemory|\boom\b|cuda error|alloc.*(memory|failed)|insufficient.*vram|vram.*(insufficient|exceed|alloc)|hbm|显存不足|内存不足/i.test(msg)
}

/** 永久性故障（重试无意义，需人工改配置/提示词） */
const PERMANENT_RE = [
  'model not found',
  'missing model',
  'node[^\\n]*not found',
  'missing node',
  'not installed',
  '找不到模型',
  '缺少模型',
  '模型.*(不存在|未安装|缺失)',
  '节点.*(不存在|未安装|缺失)',
  '参数(错误|非法|无效)',
  'invalid (prompt|parameter|argument)',
  'unsupported',
  '不支持',
  '内容(安全)?拦截',
  'content (policy|filter)'
].join('|')
const PERMANENT = new RegExp(PERMANENT_RE, 'i')

/**
 * 失败分层（REQ-11 MP-04）：OOM → 返回 'oom'；瞬时故障 → 'transient'；
 * 命中的永久性错误 → 'permanent'；其余 → 'unknown'。判定顺序与重试策略一致。
 */
export function classifyError(err: unknown): ErrorKind {
  if (isOomError(err)) return 'oom'
  if (isTransientError(err)) return 'transient'
  const msg = err instanceof Error ? err.message : String(err)
  return PERMANENT.test(msg) ? 'permanent' : 'unknown'
}
