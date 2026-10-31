import { statfs } from 'node:fs/promises'

export interface DiskSpaceInfo {
  freeBytes: number
  totalBytes: number
}

/** 读取指定目录所在磁盘的可用/总空间（字节） */
export async function getDiskSpace(dir: string): Promise<DiskSpaceInfo> {
  const st = await statfs(dir)
  return {
    freeBytes: st.bavail * st.bsize,
    totalBytes: st.blocks * st.bsize
  }
}
