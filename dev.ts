/**
 * Dev entry point — sets up build-time globals so source can run directly.
 *
 * Usage:
 *   bun dev.ts                    # normal interactive REPL
 *   bun dev.ts --debug-to-stderr  # with debug logs
 *   bun --inspect-brk dev.ts      # with Bun inspector (Chrome DevTools)
 */
;(globalThis as any).MACRO = {
  VERSION: '2.1.88-dev',
  BUILD_TIME: new Date().toISOString(),
  ISSUES_EXPLAINER:
    'report the issue at https://github.com/anthropics/claude-code/issues',
  FEEDBACK_CHANNEL: 'https://github.com/anthropics/claude-code/issues',
  PACKAGE_URL: 'https://www.npmjs.com/package/@anthropic-ai/claude-code',
  NATIVE_PACKAGE_URL:
    'https://www.npmjs.com/package/@anthropic-ai/claude-code',
  VERSION_CHANGELOG: '',
}

await import('./src/entrypoints/cli.tsx')
