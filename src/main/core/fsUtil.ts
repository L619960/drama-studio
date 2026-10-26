import * as fs from 'node:fs/promises'

/** 原子写 JSON：先落 `.tmp` 再 rename，崩溃不会留下半截文件 */
export async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  const tmp = `${filePath}.tmp`
  await fs.writeFile(tmp, JSON.stringify(data, null, 2))
  await fs.rename(tmp, filePath)
}
