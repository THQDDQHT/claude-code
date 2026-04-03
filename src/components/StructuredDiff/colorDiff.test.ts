import { expect, test } from 'bun:test'

import {
  expectColorDiff,
  expectColorFile,
} from './colorDiff.js'

test('expectColorDiff returns null when the installed module lacks render', () => {
  expect(expectColorDiff()).toBeNull()
})

test('expectColorFile returns null when the installed module lacks render', () => {
  expect(expectColorFile()).toBeNull()
})
