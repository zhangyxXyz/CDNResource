'use strict'
const fs = require('node:fs')
const path = require('node:path')
const DOMAIN = 'https://cdn.onlyzyx.com/'
async function refresh({ client, save, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now }) {
  // Do not retry an ambiguous submission: it may already have consumed quota.
  const result = await client.PurgePathCache({ Paths: [DOMAIN], FlushType: 'flush' })
  if (!result.TaskId) throw new Error('Missing CDN TaskId')
  const record = { taskId: result.TaskId, domain: DOMAIN, status: 'process' }
  save(record)
  const deadline = now() + 300000
  while (now() < deadline) {
    const response = await client.DescribePurgeTasks({ TaskId: record.taskId, PurgeType: 'path', Limit: 100 })
    const tasks = (response.PurgeLogs || []).filter(task => task.TaskId === record.taskId && task.Url === DOMAIN && task.PurgeType === 'path')
    if (Number(response.TotalCount) > (response.PurgeLogs || []).length) throw new Error('Incomplete CDN task response')
    if (tasks.some(task => !['process', 'done'].includes(task.Status))) throw new Error('CDN refresh failed')
    if (tasks.length && tasks.every(task => task.Status === 'done')) {
      save({ ...record, status: 'done', completedAt: new Date(now()).toISOString() })
      return record.taskId
    }
    await sleep(5000)
  }
  throw new Error('CDN refresh wait timed out; inspect saved TaskId before retrying')
}
async function main() {
  const { SECRET_ID, SECRET_KEY } = process.env
  if (!SECRET_ID || !SECRET_KEY) throw new Error('Missing CDN credentials')
  const { cdn } = require('tencentcloud-sdk-nodejs-cdn')
  const client = new cdn.v20180606.Client({ credential: { secretId: SECRET_ID, secretKey: SECRET_KEY },
    profile: { httpProfile: { reqTimeout: 20 } } })
  const directory = path.join(__dirname, 'artifacts')
  fs.mkdirSync(directory, { recursive: true })
  const taskId = await refresh({ client, save: data => fs.writeFileSync(path.join(directory, 'cdn.json'), JSON.stringify(data, null, 2) + '\n') })
  console.log('Resource CDN refresh completed:', taskId)
}
if (require.main === module) main().catch(error => {
  console.error('Resource CDN refresh failed:', String(error.code || error.name || 'Error').replace(/[^A-Za-z0-9_.-]/g, ''))
  process.exitCode = 1
})
module.exports = { refresh }
