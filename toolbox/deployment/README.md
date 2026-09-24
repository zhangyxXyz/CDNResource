# 资源发布

推送 `main` 自动执行，也可从 Actions 的 **Run workflow** 手动触发。
失败重试会重新读取 COS 目录，只上传缺失或内容变化的文件，不会重传已匹配文件。
不要对旧提交使用 Re-run 来验证新流水线；应运行包含新代码的提交。

发布工具使用锁定版本的腾讯云官方 COS/CDN SDK，凭据只从 GitHub Secrets 注入环境变量。
目标固定为上海资源桶的 `static/` 前缀，CDN 固定为 `https://cdn.onlyzyx.com/`。

1. 分页读取远端清单，与本地文件大小和 MD5 比较。普通文件直接使用 ETag；旧分片对象使用 HEAD 中的 MD5 元数据，缺少可靠摘要时重新上传。
2. 四个文件任务并发，只传差异。网络慢、超时、限流或服务端临时错误最多重试三次；每次重新打开文件流。超过 1 MiB 的文件使用官方 SDK 分片上传，每片 1 MiB、三个分片并发，开启分片 MD5 校验及续传；分片内部最多重试两次。日志输出上传字节数。
3. 上传后验证 ETag 和 HEAD，再核验全量远端及本地清单。只有全部通过才清理旧文件；日志、备份和前缀外对象保留。
4. 独立刷新资源 CDN，等待对应任务完成。上传失败会跳过该步骤。

发布记录通过 Actions artifact 保存 14 天。工作流串行运行，避免两次资源发布相互清理。

```sh
pnpm --dir toolbox/deployment install --frozen-lockfile
pnpm --dir toolbox/deployment test
# 设置 SECRET_ID、SECRET_KEY、BUCKET、REGION 后，只读查看差异：
node toolbox/deployment/sync.cjs --check
# 真正同步：
node toolbox/deployment/sync.cjs --apply
node toolbox/deployment/cdn.cjs
```

大范围首次迁移仍受运行机器到 COS 的网络速度影响；增量重试不重复传输成功文件。
