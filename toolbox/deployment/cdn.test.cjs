'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { refresh } = require('./cdn.cjs')
const task = Status => ({ TaskId: 'task-1', Url: 'https://cdn.onlyzyx.com/', PurgeType: 'path', Status })
test('submits once and waits for the matching resource CDN task', async () => {
  let submits = 0, polls = 0
  const saved = []
  await refresh({ client: {
    PurgePathCache: async p => { submits++; assert.deepEqual(p.Paths, ['https://cdn.onlyzyx.com/']); return { TaskId: 'task-1' } },
    DescribePurgeTasks: async () => ({ TotalCount: 1, PurgeLogs: [task(++polls === 1 ? 'process' : 'done')] })
  }, save: r => saved.push(r), sleep: async () => {} })
  assert.equal(submits, 1)
  assert.equal(polls, 2)
  assert.equal(saved.at(-1).status, 'done')
})
test('failed or missing CDN tasks never report success', async () => {
  for (const state of ['fail', 'missing']) {
    let time = 0
    await assert.rejects(refresh({ client: {
      PurgePathCache: async () => ({ TaskId: 'task-1' }),
      DescribePurgeTasks: async () => ({ TotalCount: state === 'missing' ? 0 : 1, PurgeLogs: state === 'missing' ? [] : [task('fail')] })
    }, save: () => {}, now: () => time, sleep: async () => { time += 300000 } }), /failed|timed out/)
  }
})
