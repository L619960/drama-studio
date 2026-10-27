// Flat config for ESLint v10 (project is "type": "module" → ESM).
// 基于 @electron-toolkit/eslint-config-ts v4（已为 flat config）+ eslint-plugin-vue。
import tseslint from 'typescript-eslint'
import electronToolkit from '@electron-toolkit/eslint-config-ts'
import pluginVue from 'eslint-plugin-vue'
import vueParser from 'vue-eslint-parser'

export default tseslint.config(
  // 通用忽略
  {
    ignores: [
      '**/node_modules/**',
      '**/out/**',
      '**/dist/**',
      '**/coverage/**',
      '**/.husky/**',
      '**/build/**',
      '**/skills/**',
      '**/workflows/**'
    ]
  },

  // electron-toolkit 推荐集（含 base + tseslint.configs.recommended + ts 规则）
  ...electronToolkit.configs.recommended,

  // Vue 3 SFC 支持
  ...pluginVue.configs['flat/recommended'],

  // .vue 文件的 <script> 块用 typescript-eslint parser 解析
  {
    files: ['**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        parser: tseslint.parser,
        ecmaVersion: 'latest',
        sourceType: 'module'
      }
    }
  },

  // 项目自定义规则：不强制全仓修 style，只开最基础的。
  // 历史代码体量较大，对会引发大面积重写的规则一律降为 warn（不改业务逻辑）。
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      // explicit-function-return-type 在 electron-toolkit 里是 error；项目体量太大，降为 warn 避免阻塞
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      // 历史代码大量 try/catch 空块（兜底吞错），降为 warn
      'no-empty': 'warn',
      // 历史代码大量 `let x = ...; x = ...` 模式，降为 warn
      'no-useless-assignment': 'warn',
      // 历史 throw new Error(...) 未带 cause，降为 warn
      'preserve-caught-error': 'warn',
      // 测试文件用 require mock，降为 warn
      '@typescript-eslint/no-require-imports': 'warn',
      '@typescript-eslint/no-unused-expressions': 'warn',
      'no-control-regex': 'warn',
      'no-useless-escape': 'warn',
      // Vue 模板规则降到 warn，避免阻塞
      'vue/multi-word-component-names': 'off',
      'vue/no-v-html': 'off',
      'vue/require-default-prop': 'off',
      'vue/attributes-order': 'off',
      'vue/html-indent': 'off',
      'vue/max-attributes-per-line': 'off',
      'vue/singleline-html-element-content-newline': 'off',
      'vue/html-self-closing': 'off',
      'vue/first-attribute-linebreak': 'off',
      'vue/html-closing-bracket-newline': 'off',
      'vue/one-component-per-file': 'off',
      // 70+ 处 prop 直接 mutation（Element Plus 双向绑定模式），重构工作量大，降为 warn
      'vue/no-mutating-props': 'warn'
    }
  }
)
