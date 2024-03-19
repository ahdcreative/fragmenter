'use strict';

module.exports = {
    root: true,
    env: {
        'node': true,
        'browser': true,
        'jest/globals': true
    },
    plugins: [
        '@typescript-eslint',
        'jest'
    ],
    parser: "@typescript-eslint/parser",
    parserOptions: {
        ecmaVersion: 2023,
        sourceType: "script",
        requireConfigFile: false
    },
    overrides: [
        {
            files: ['*.mjs', '*.ts', '*.d.ts'],
            parserOptions: { sourceType: 'module' },
        },
    ],
    rules: {
        'object-curly-newline': ['error', { multiline: true }],
        'no-await-in-loop': 'off',
        'no-console': 'off',
        'no-useless-constructor': 'off',
        'no-empty-function': 'off',
        'import/no-unresolved': 'off',
        'no-undef': 'off',
        'no-labels': 'off',
        'no-else-return': 'off',
    },
}