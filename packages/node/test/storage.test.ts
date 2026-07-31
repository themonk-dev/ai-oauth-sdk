import { mkdtemp, rm, stat, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { fileStorage } from '../src/storage.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aioauth-test-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('fileStorage', () => {
  it('round-trips values', async () => {
    const storage = fileStorage({ dir })
    expect(await storage.get('missing')).toBeNull()

    await storage.set('tokens:openai', '{"accessToken":"abc"}')
    expect(await storage.get('tokens:openai')).toBe('{"accessToken":"abc"}')

    await storage.delete('tokens:openai')
    expect(await storage.get('tokens:openai')).toBeNull()
  })

  it('writes the credential file as 0600', async () => {
    const storage = fileStorage({ dir })
    await storage.set('k', 'v')

    const stats = await stat(join(dir, 'auth.json'))
    // Other users on a shared box must not be able to read the tokens.
    expect(stats.mode & 0o777).toBe(0o600)
  })

  it('keeps several keys in one file', async () => {
    const storage = fileStorage({ dir })
    await storage.set('a', '1')
    await storage.set('b', '2')

    expect(await storage.get('a')).toBe('1')
    expect(await storage.get('b')).toBe('2')
    expect(JSON.parse(await readFile(join(dir, 'auth.json'), 'utf8'))).toEqual({ a: '1', b: '2' })
  })

  it('does not lose writes under concurrency', async () => {
    const storage = fileStorage({ dir })
    // Ten unserialised read-modify-writes would clobber each other; the queue
    // is what makes this safe.
    await Promise.all(Array.from({ length: 10 }, (_, i) => storage.set(`key-${i}`, String(i))))

    const record = JSON.parse(await readFile(join(dir, 'auth.json'), 'utf8'))
    expect(Object.keys(record)).toHaveLength(10)

    for (let i = 0; i < 10; i++) {
      expect(record[`key-${i}`]).toBe(String(i))
    }
  })

  it('recovers from a corrupt file instead of wedging login', async () => {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'auth.json'), 'not json at all')

    const storage = fileStorage({ dir })
    expect(await storage.get('anything')).toBeNull()

    await storage.set('fresh', 'value')
    expect(await storage.get('fresh')).toBe('value')
  })

  it('creates nested directories on demand', async () => {
    const nested = join(dir, 'a', 'b', 'c')
    const storage = fileStorage({ dir: nested })
    await storage.set('k', 'v')
    expect(await storage.get('k')).toBe('v')
  })

  it('deleting an absent key is a no-op', async () => {
    const storage = fileStorage({ dir })
    await expect(storage.delete('nothing')).resolves.toBeUndefined()
  })
})
