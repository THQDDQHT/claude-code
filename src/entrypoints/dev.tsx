import packageJson from '../../package.json'

// Provide the build-time MACRO constants that the source entrypoint expects.
;(globalThis as any).MACRO = {
  VERSION: `${packageJson.version}-dev`,
  BUILD_TIME: new Date().toISOString(),
  ISSUES_EXPLAINER:
    'report the issue at https://github.com/anthropics/claude-code/issues',
  FEEDBACK_CHANNEL: 'https://github.com/anthropics/claude-code/issues',
  PACKAGE_URL: 'https://www.npmjs.com/package/@anthropic-ai/claude-code',
  NATIVE_PACKAGE_URL: 'https://www.npmjs.com/package/@anthropic-ai/claude-code',
  VERSION_CHANGELOG: '',
}

await import('./cli.tsx')
