import { expect, test } from 'bun:test'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(__dirname, '..', '..')

async function spawnDevEntrypoint(
  args: string[],
  env?: Record<string, string | undefined>,
) {
  const proc = Bun.spawn([process.execPath, 'src/entrypoints/dev.tsx', ...args], {
    cwd: projectRoot,
    env: {
      ...process.env,
      ...env,
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])

  return { stdout, stderr, exitCode }
}

test('dev entrypoint prints version without requiring a build', async () => {
  const { stdout, stderr, exitCode } = await spawnDevEntrypoint(['--version'])

  expect(exitCode).toBe(0)
  expect(stdout.trim()).toContain('(Claude Code)')
  expect(stderr).toBe('')
})

test('dev entrypoint exits when debugger inspection is detected by default', async () => {
  const { stdout, stderr, exitCode } = await spawnDevEntrypoint(['--help'], {
    NODE_OPTIONS: '--inspect-publish-uid=http',
    CLAUDE_CODE_ALLOW_DEBUGGER: undefined,
  })

  expect(exitCode).toBe(1)
  expect(stdout.includes('Usage: claude')).toBe(false)
  expect(stderr).toBe('')
})

test('dev entrypoint allows debugger inspection when explicitly enabled', async () => {
  const { stdout, stderr, exitCode } = await spawnDevEntrypoint(['--help'], {
    NODE_OPTIONS: '--inspect-publish-uid=http',
    CLAUDE_CODE_ALLOW_DEBUGGER: '1',
  })

  expect(exitCode).toBe(0)
  expect(stdout).toContain('Usage: claude')
  expect(stderr).toBe('')
})
