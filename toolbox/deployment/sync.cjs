'use strict'
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const ROOT = path.resolve(__dirname, '../..')
const PREFIX = 'static/'
const normalize = value => String(value || '').replace(/^"|"$/g, '').toLowerCase()
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const safeCode = error => String(error?.code || error?.name || 'Error').replace(/[^A-Za-z0-9_.-]/g, '')

async function retry(operation, { sleep = delay, log = console.log } = {}) {
  for (let attempt = 1; ; attempt++) {
    try { return await operation() } catch (error) {
      const transient = Number(error.statusCode) >= 500 || Number(error.statusCode) === 429 ||
        /^(UserNetworkTooSlow|RequestTimeout|SlowDown|InternalError|ServiceUnavailable|ETIMEDOUT|ESOCKETTIMEDOUT|ECONNRESET|EAI_AGAIN|NetworkingError)$/.test(error.code || '')
      if (!transient || attempt >= 4) throw error
      log(`Transient ${safeCode(error)}; retry ${attempt}/3`)
      await sleep(1000 * 2 ** (attempt - 1))
    }
  }
}

async function pool(items, operation) {
  let next = 0, failure
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
    while (!failure && next < items.length) {
      const item = items[next++]
      try { await operation(item) } catch (error) { failure ||= error }
    }
  }))
  if (failure) throw failure
}

async function hash(file) {
  const digest = crypto.createHash('md5')
  for await (const chunk of fs.createReadStream(file)) digest.update(chunk)
  return digest.digest('hex')
}

async function localInventory(source) {
  if (fs.lstatSync(source).isSymbolicLink()) throw new Error('Source must not be a symbolic link')
  const files = []
  async function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error('Symbolic links are not publishable')
      if (entry.isDirectory()) await walk(file)
      else if (entry.isFile()) files.push({ key: PREFIX + path.relative(source, file).split(path.sep).join('/'),
        size: fs.statSync(file).size, md5: await hash(file) })
      else throw new Error('Unsupported source entry')
    }
  }
  await walk(source)
  if (!files.length) throw new Error('Empty source; refusing synchronization')
  return files.sort((a, b) => a.key.localeCompare(b.key))
}

async function remoteInventory(call) {
  const objects = new Map(), markers = new Set()
  let marker = ''
  for (;;) {
    const response = await call('getBucket', { Prefix: PREFIX, MaxKeys: 1000, ...(marker ? { Marker: marker } : {}) })
    for (const item of response.Contents || []) {
      if (!item.Key.startsWith(PREFIX) || objects.has(item.Key)) throw new Error('Invalid or duplicate COS listing key')
      objects.set(item.Key, { key: item.Key, size: Number(item.Size), etag: normalize(item.ETag) })
    }
    if (response.IsTruncated !== true && response.IsTruncated !== 'true') return objects
    const next = response.NextMarker || response.Contents?.at(-1)?.Key
    if (!next || markers.has(next)) throw new Error('Incomplete COS listing; pagination did not advance')
    markers.add(next)
    marker = next
  }
}

async function matches(entry, remote, call) {
  if (!remote || entry.size !== remote.size) return false
  if (/^[a-f0-9]{32}$/.test(remote.etag)) return remote.etag === entry.md5
  // Legacy multipart ETags are not whole-file MD5. Only these objects need HEAD.
  const head = await call('headObject', { Key: entry.key })
  return Number(head.headers?.['content-length']) === entry.size &&
    normalize(head.headers?.['x-cos-meta-md5']) === entry.md5
}

function protectedKey(key) {
  return /(^|\/)(?:\.git|\.github|logs?|access-logs?|__release)(\/|$)|\.(?:bak|log|tmp)$/i.test(key)
}

async function synchronize({ source, call, apply = false, save = () => {}, log = console.log, contentType = () => 'application/octet-stream' }) {
  const local = await localInventory(source), before = await remoteInventory(call)
  const changed = []
  await pool(local, async entry => { if (!await matches(entry, before.get(entry.key), call)) changed.push(entry) })
  const keys = new Set(local.map(entry => entry.key))
  const obsolete = [...before.values()].filter(entry => !keys.has(entry.key) && !protectedKey(entry.key))
  const summary = { local: local.length, unchanged: local.length - changed.length, upload: changed.length,
    uploadBytes: changed.reduce((n, entry) => n + entry.size, 0), deleteAfterVerification: obsolete.length }
  save('plan', { ...summary, uploads: changed, obsolete, before: [...before.values()] })
  log(JSON.stringify(summary))
  if (!apply) return summary
  let uploaded = 0
  await pool(changed, async entry => {
    const file = path.join(source, entry.key.slice(PREFIX.length))
    if (fs.statSync(file).size !== entry.size || await hash(file) !== entry.md5) throw new Error('Source changed before upload')
    // Recreate the stream for each retry; never reuse a consumed stream.
    const result = await call('putObject', () => ({ Key: entry.key, Body: fs.createReadStream(file),
      ContentLength: entry.size, ContentType: contentType(entry.key),
      ContentMD5: Buffer.from(entry.md5, 'hex').toString('base64'),
      Headers: { 'x-cos-meta-md5': entry.md5 } }))
    if (normalize(result.ETag) !== entry.md5) throw new Error('Uploaded ETag mismatch: ' + entry.key)
    const head = await call('headObject', { Key: entry.key })
    if (normalize(head.ETag || head.headers?.etag) !== entry.md5 || Number(head.headers?.['content-length']) !== entry.size) {
      throw new Error('Uploaded HEAD mismatch: ' + entry.key)
    }
    uploaded++
    log(`Uploaded and verified ${uploaded}/${changed.length}: ${entry.key}`)
  })
  // Verify the entire target and unchanged local tree before any cleanup.
  const after = await remoteInventory(call)
  await pool(local, async entry => {
    if (!await matches(entry, after.get(entry.key), call)) throw new Error('Final inventory mismatch: ' + entry.key)
  })
  if (JSON.stringify(await localInventory(source)) !== JSON.stringify(local)) throw new Error('Source changed; cleanup cancelled')
  for (const entry of obsolete) {
    const current = after.get(entry.key)
    if (current && (current.etag !== entry.etag || current.size !== entry.size)) throw new Error('Obsolete object changed; cleanup cancelled')
  }
  save('verified', { ...summary, verified: local.length, uploaded })
  await pool(obsolete, async entry => {
    if (!after.has(entry.key)) return
    const head = await call('headObject', { Key: entry.key })
    if (normalize(head.ETag || head.headers?.etag) !== entry.etag || Number(head.headers?.['content-length']) !== entry.size) {
      throw new Error('Concurrent change; cleanup stopped')
    }
    await call('deleteObject', { Key: entry.key })
  })
  save('complete', { ...summary, uploaded, verified: local.length, completedAt: new Date().toISOString() })
  log(`Complete: uploaded ${uploaded}, verified ${local.length}, obsolete ${obsolete.length}`)
  return summary
}

async function main() {
  const mode = process.argv[2] || '--check'
  if (process.argv.length > 3 || !['--check', '--apply'].includes(mode)) throw new Error('Use --check or --apply')
  const { SECRET_ID, SECRET_KEY, BUCKET, REGION } = process.env
  if (!SECRET_ID || !SECRET_KEY || BUCKET !== 'resource-1256849825' || REGION !== 'ap-shanghai') {
    throw new Error('Missing credentials or unexpected resource COS destination')
  }
  const COS = require('cos-nodejs-sdk-v5'), mime = require('mime-types')
  const cos = new COS({ SecretId: SECRET_ID, SecretKey: SECRET_KEY, Timeout: 60000, RetryTimes: 0 })
  const call = (method, parameters) => retry(() => new Promise((resolve, reject) => {
    const args = typeof parameters === 'function' ? parameters() : parameters
    cos[method]({ Bucket: BUCKET, Region: REGION, ...args }, (error, result) => {
      if (error) { args.Body?.destroy?.(); reject(error) } else resolve(result)
    })
  }))
  const directory = path.join(__dirname, 'artifacts')
  fs.mkdirSync(directory, { recursive: true })
  const save = (name, data) => fs.writeFileSync(path.join(directory, name + '.json'), JSON.stringify(data, null, 2) + '\n')
  const source = path.join(ROOT, 'static')
  if (!fs.existsSync(path.join(source, 'vendor/elemecdn/akilar-live2dapi@latest/model_list.json'))) throw new Error('Required resource index missing')
  try {
    await synchronize({ source, call, apply: mode === '--apply', save, contentType: key => mime.lookup(key) || 'application/octet-stream' })
  } catch (error) {
    save('failure', { code: safeCode(error), completedAt: new Date().toISOString() })
    throw error
  }
}
if (require.main === module) main().catch(error => { console.error('Resource synchronization failed:', safeCode(error)); process.exitCode = 1 })
module.exports = { synchronize, retry, remoteInventory, localInventory, matches }
