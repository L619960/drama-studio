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
      // 允许 _ 前缀变量/catch 形参故意留空（解构占位、cause 透传等）
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_'
        }
      ],
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
      // P2-08：当前 lint 已 0 violation，把该规则从 warn 升为 error 固化门禁；
      // 已接受"就地编辑 props 对象"的组件组在下面单独关闭（不重写业务逻辑）。
      'vue/no-mutating-props': 'error'
    }
  },

  // 设置/面板类组件以 `:settings="settings"` 传入响应式对象，子组件就地编辑其属性
  // （Element Plus v-model 双向绑定的既有约定）。这是项目已接受的模式，逐处改 emit
  // 会重写业务逻辑，故对这些组件关闭该规则；其余 .vue 仍保持 warn。
  {
    files: [
      'src/renderer/src/components/settings/**/*.vue',
      'src/renderer/src/components/console/MemoryPanel.vue',
      'src/renderer/src/components/console/SkillsPanel.vue',
      'src/renderer/src/components/storyboard/ShotReviewDialog.vue'
    ],
    rules: {
      'vue/no-mutating-props': 'off'
    }
  },

  // tests/ 用最小 mock 对象替代真实服务（store/llm/ffmpeg 等），`any` 是测试脚手架常态；
  // 产品代码中的 any 仍按 warn 治理。
  {
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off'
    }
  },

  // scripts/ 是本地一次性开发/性能度量/归档修复脚本（非主进程/渲染进程产品代码），
  // 其中空 catch 兜底、临时变量残留属工具脚本常态，不纳入产品代码 lint 治理。
  {
    files: ['scripts/**/*.{mjs,js,cjs}'],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
      'no-useless-assignment': 'off',
      'no-empty': 'off',
      '@typescript-eslint/no-unused-expressions': 'off'
    }
  }
)
