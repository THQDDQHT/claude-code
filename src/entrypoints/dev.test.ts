import { expect, test } from 'bun:test'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(__dirname, '..', '..')

test('dev entrypoint prints version without requiring a build', async () => {
  const proc = Bun.spawn(
    [process.execPath, 'src/entrypoints/dev.tsx', '--version'],
    {
      cwd: projectRoot,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])

  expect(exitCode).toBe(0)
  expect(stdout.trim()).toContain('(Claude Code)')
  expect(stderr).toBe('')
})
