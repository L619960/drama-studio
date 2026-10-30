/** RC-10：控制台中栏模块选择持久化（切页/切项目后回来仍停在原模块） */
export const CONSOLE_MODULE_KEY = 'drama-studio:consoleModule'

export const CONSOLE_MODULES = ['workflow', 'skills', 'memory', 'comfyui', 'selfcheck'] as const
export type ConsoleModule = typeof CONSOLE_MODULES[number]

export function isConsoleModule(value: unknown): value is ConsoleModule {
  return typeof value === 'string' && (CONSOLE_MODULES as readonly string[]).includes(value)
}

export function readConsoleModule(): ConsoleModule {
  const saved = typeof localStorage === 'undefined' ? null : localStorage.getItem(CONSOLE_MODULE_KEY)
  return isConsoleModule(saved) ? saved : 'workflow'
}

export function saveConsoleModule(module: string): void {
  if (typeof localStorage === 'undefined' || !isConsoleModule(module)) return
  localStorage.setItem(CONSOLE_MODULE_KEY, module)
}
