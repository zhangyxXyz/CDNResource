'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto')
const { synchronize, retry, remoteInventory } = require('./sync.cjs')
const md5 = value => crypto.createHash('md5').update(value).digest('hex')
function fixture(t) {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-sync-'))
  t.after(() => fs.rmSync(source, { recursive: true, force: true }))
  for (const [name, content] of Object.entries({ 'same.txt': 'same', 'multipart.txt': 'legacy', 'new.txt': 'new' })) fs.writeFileSync(path.join(source, name), content)
  const remote = new Map([
    ['static/same.txt', { body: 'same', etag: md5('same') }],
    ['static/multipart.txt', { body: 'legacy', etag: 'abc-2', metadata: md5('legacy') }],
    ['static/old.txt', { body: 'old', etag: md5('old') }],
    ['static/logs/access.log', { body: 'log', etag: md5('log') }]
  ])
  const calls = []
  async function call(method, parameters) {
    const p = typeof parameters === 'function' ? parameters() : parameters
    calls.push({ method, key: p.Key })
    if (method === 'getBucket') {
      assert.equal(p.Prefix, 'static/')
      return { Contents: [...remote].map(([Key, v]) => ({ Key, Size: Buffer.byteLength(v.body), ETag: v.etag })), IsTruncated: false }
    }
    if (method === 'putObject') {
      const chunks = []
      for await (const chunk of p.Body) chunks.push(chunk)
      const body = Buffer.concat(chunks), etag = md5(body)
      assert.equal(p.ContentMD5, Buffer.from(etag, 'hex').toString('base64'))
      remote.set(p.Key, { body, etag, metadata: p.Headers['x-cos-meta-md5'] })
      return { ETag: etag }
    }
    if (method === 'headObject') {
      const v = remote.get(p.Key)
      return { ETag: v.etag, headers: { etag: v.etag, 'content-length': String(Buffer.byteLength(v.body)), 'x-cos-meta-md5': v.metadata } }
    }
    if (method === 'deleteObject') { remote.delete(p.Key); return {} }
    throw new Error('Unexpected method')
  }
  return { source, remote, calls, call, log: () => {} }
}
test('incremental upload skips simple and legacy multipart objects; verifies before cleanup', async t => {
  const f = fixture(t)
  const summary = await synchronize({ ...f, apply: true })
  assert.equal(summary.upload, 1)
  assert.equal(summary.unchanged, 2)
  assert.deepEqual(f.calls.filter(c => c.method === 'putObject').map(c => c.key), ['static/new.txt'])
  assert.equal(f.calls.some(c => c.method === 'headObject' && c.key === 'static/same.txt'), false)
  assert.equal(f.remote.has('static/old.txt'), false)
  assert.equal(f.remote.has('static/logs/access.log'), true)
  assert.equal((await synchronize({ ...f, apply: true })).upload, 0)
})
test('dry run never uploads or deletes', async t => {
  const f = fixture(t)
  assert.equal((await synchronize(f)).upload, 1)
  assert.equal(f.calls.some(c => ['putObject', 'deleteObject'].includes(c.method)), false)
})
test('failed upload retains obsolete objects', async t => {
  const f = fixture(t)
  await assert.rejects(synchronize({ ...f, apply: true, call: (m, p) => {
    if (m === 'putObject') throw Object.assign(new Error(), { code: 'UserNetworkTooSlow' })
    return f.call(m, p)
  } }))
  assert.equal(f.calls.some(c => c.method === 'deleteObject'), false)
  assert.equal(f.remote.has('static/old.txt'), true)
})
test('HEAD verification failure prevents cleanup', async t => {
  const f = fixture(t)
  await assert.rejects(synchronize({ ...f, apply: true, call: async (m, p) => {
    const r = await f.call(m, p)
    if (m === 'headObject' && p.Key === 'static/new.txt') r.headers['content-length'] = '0'
    return r
  } }), /HEAD mismatch/)
  assert.equal(f.calls.some(c => c.method === 'deleteObject'), false)
})
test('content changes with identical size are uploaded', async t => {
  const f = fixture(t)
  fs.writeFileSync(path.join(f.source, 'same.txt'), 'diff')
  assert.equal((await synchronize({ ...f, apply: true })).upload, 2)
})
test('pagination follows markers and rejects stalled or out-of-prefix results', async () => {
  let page = 0
  const objects = await remoteInventory(async (_, p) => {
    assert.equal(p.Marker, page ? 'next' : undefined)
    page++
    return { Contents: [{ Key: 'static/' + page, Size: 1, ETag: 'x' }], IsTruncated: page === 1, NextMarker: 'next' }
  })
  assert.equal(objects.size, 2)
  await assert.rejects(remoteInventory(async () => ({ Contents: [], IsTruncated: true, NextMarker: 'stuck' })), /pagination/)
  await assert.rejects(remoteInventory(async () => ({ Contents: [{ Key: 'other/file' }] })), /Invalid/)
})
test('transient errors retry with a limit; access errors do not retry', async () => {
  const waits = [], options = { sleep: async n => waits.push(n), log: () => {} }
  let attempts = 0
  await retry(async () => { if (++attempts < 3) throw { code: 'UserNetworkTooSlow' } }, options)
  assert.equal(attempts, 3)
  assert.deepEqual(waits, [1000, 2000])
  attempts = 0
  await assert.rejects(retry(async () => { attempts++; throw { code: 'AccessDenied', statusCode: 403 } }, options))
  assert.equal(attempts, 1)
  attempts = 0
  await assert.rejects(retry(async () => { attempts++; throw { code: 'ETIMEDOUT' } }, options))
  assert.equal(attempts, 4)
})
