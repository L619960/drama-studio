module.exports = {
  extends: '@electron-toolkit/eslint-config-ts',
  parserOptions: { ecmaVersion: 'latest' },
  env: { node: true, browser: true },
  rules: {
    // 不强制全仓修 style，只开最基础的
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }]
  }
}
