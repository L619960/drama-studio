import { deflateRawSync, inflateRawSync } from 'node:zlib'

/**
 * 最小 ZIP 读写（REQ-20）：只覆盖项目包所需能力，不引入第三方依赖。
 * 写入统一 UTF-8 文件名（通用标志位 bit 11），压缩方式按体积择优（deflate / store）；
 * 读取支持 compact 项目包，遇到 Zip64 / 加密条目直接给出可读错误。
 */

export interface ZipEntryInput {
  /** 包内相对路径，统一使用 `/` 分隔 */
  path: string
  data: Buffer
}

export interface ZipEntry {
  path: string
  data: Buffer
}

/** 单文件上限：ZIP 经典格式 4GB 以下（Zip64 未实现） */
const MAX_ENTRY_BYTES = 0xffffffff - 1
const FLAG_UTF8 = 0x0800
const METHOD_STORE = 0
const METHOD_DEFLATE = 8
/** 固定 1980-01-01 00:00:00，避免不同时区导出结果不可复现 */
const DOS_TIME = 0
const DOS_DATE = ((1980 - 1980) << 9) | (1 << 5) | 1

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** 路径安全：拒绝绝对路径 / 盘符 / `..` 段，导入时防目录穿越 */
export function assertSafeEntryPath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '')
  if (!normalized || normalized.includes('\0')) throw new Error(`项目包含有非法路径：${path}`)
  if (/^[A-Za-z]:/.test(normalized) || normalized.startsWith('/')) {
    throw new Error(`项目包含有非法绝对路径：${path}`)
  }
  const segments = normalized.split('/')
  if (segments.some(s => s === '..' || s === '.')) {
    throw new Error(`项目包含有非法路径：${path}`)
  }
  return normalized
}

interface PreparedEntry {
  path: string
  data: Buffer
  crc: number
  method: number
  compressed: Buffer
}

function prepare(entry: ZipEntryInput): PreparedEntry {
  const path = assertSafeEntryPath(entry.path)
  if (entry.data.length > MAX_ENTRY_BYTES) {
    throw new Error(`文件过大，暂不支持打包：${path}`)
  }
  const deflated = deflateRawSync(entry.data, { level: 6 })
  const useDeflate = deflated.length < entry.data.length
  return {
    path,
    data: entry.data,
    crc: crc32(entry.data),
    method: useDeflate ? METHOD_DEFLATE : METHOD_STORE,
    compressed: useDeflate ? deflated : entry.data
  }
}

/** 生成 ZIP；条目顺序按入参保持（调用方负责排序以保证可复现） */
export function createZip(entries: ZipEntryInput[]): Buffer {
  const prepared = entries.map(prepare)
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0

  for (const e of prepared) {
    const nameBuf = Buffer.from(e.path, 'utf8')
    const local = Buffer.alloc(30 + nameBuf.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(FLAG_UTF8, 6)
    local.writeUInt16LE(e.method, 8)
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(e.crc, 14)
    local.writeUInt32LE(e.compressed.length, 18)
    local.writeUInt32LE(e.data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    nameBuf.copy(local, 30)

    localParts.push(local, e.compressed)

    const central = Buffer.alloc(46 + nameBuf.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(FLAG_UTF8, 8)
    central.writeUInt16LE(e.method, 10)
    central.writeUInt16LE(DOS_TIME, 12)
    central.writeUInt16LE(DOS_DATE, 14)
    central.writeUInt32LE(e.crc, 16)
    central.writeUInt32LE(e.compressed.length, 20)
    central.writeUInt32LE(e.data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30) // extra
    central.writeUInt16LE(0, 32) // comment
    central.writeUInt16LE(0, 34) // disk start
    central.writeUInt16LE(0, 36) // internal attrs
    central.writeUInt32LE(0, 38) // external attrs
    central.writeUInt32LE(offset, 42)
    nameBuf.copy(central, 46)
    centralParts.push(central)

    offset += local.length + e.compressed.length
  }

  const centralSize = centralParts.reduce((n, b) => n + b.length, 0)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(prepared.length, 8)
  eocd.writeUInt16LE(prepared.length, 10)
  eocd.writeUInt32LE(centralSize, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...localParts, ...centralParts, eocd])
}

/** 解析 ZIP；仅支持 store/deflate，遇到加密或 Zip64 抛中文错误 */
export function readZip(zip: Buffer): ZipEntry[] {
  let eocd = -1
  const minPos = Math.max(0, zip.length - 22 - 0xffff)
  for (let i = zip.length - 22; i >= minPos; i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('不是有效的项目包（ZIP 结构缺失）')

  const count = zip.readUInt16LE(eocd + 10)
  const cdOffset = zip.readUInt32LE(eocd + 16)
  if (count === 0xffff || cdOffset === 0xffffffff) throw new Error('项目包过大（暂不支持 Zip64）')

  const entries: ZipEntry[] = []
  let p = cdOffset
  for (let i = 0; i < count; i++) {
    if (p + 46 > zip.length || zip.readUInt32LE(p) !== 0x02014b50) {
      throw new Error('项目包损坏：中央目录不可读')
    }
    const flags = zip.readUInt16LE(p + 8)
    if (flags & 1) throw new Error('项目包已加密，暂不支持导入')
    const method = zip.readUInt16LE(p + 10)
    const compSize = zip.readUInt32LE(p + 20)
    const uncompSize = zip.readUInt32LE(p + 24)
    const nameLen = zip.readUInt16LE(p + 28)
    const extraLen = zip.readUInt16LE(p + 30)
    const commentLen = zip.readUInt16LE(p + 32)
    const localOffset = zip.readUInt32LE(p + 42)
    const name = zip.toString('utf8', p + 46, p + 46 + nameLen)
    p += 46 + nameLen + extraLen + commentLen

    if (name.endsWith('/')) continue // 目录条目：导入时按文件路径自动建目录
    if (compSize === 0xffffffff || uncompSize === 0xffffffff) {
      throw new Error('项目包过大（暂不支持 Zip64）')
    }
    if (localOffset + 30 > zip.length || zip.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`项目包损坏：${name} 本地头不可读`)
    }
    const lNameLen = zip.readUInt16LE(localOffset + 26)
    const lExtraLen = zip.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + lNameLen + lExtraLen
    const raw = zip.subarray(dataStart, dataStart + compSize)
    if (raw.length !== compSize) throw new Error(`项目包损坏：${name} 数据不完整`)

    const data = method === METHOD_DEFLATE
      ? inflateRawSync(raw)
      : method === METHOD_STORE ? Buffer.from(raw) : null
    if (data === null) throw new Error(`项目包使用了不支持的压缩方式（${method}）`)
    if (data.length !== uncompSize) throw new Error(`项目包损坏：${name} 长度不符`)
    entries.push({ path: assertSafeEntryPath(name), data })
  }
  return entries
}
