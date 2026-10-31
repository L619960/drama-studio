import { statfs } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface DiskSpaceInfo {
  freeBytes: number
  totalBytes: number
}

/** 读取指定目录所在磁盘的可用/总空间（字节） */
export async function getDiskSpace(dir: string): Promise<DiskSpaceInfo> {
  let target = dir
  for (;;) {
    try {
      const st = await statfs(target)
      return {
        freeBytes: st.bavail * st.bsize,
        totalBytes: st.blocks * st.bsize
      }
    } catch (err) {
      // 新装/首启用临时 profile 时数据目录可能还没创建：回退到父目录，统计的仍是同一块盘
      const parent = dirname(target)
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT' || parent === target) throw err
      target = parent
    }
  }
}
