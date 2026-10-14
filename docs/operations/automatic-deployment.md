# GitHub Actions 自动生产部署

SkillHub 在 `main` 分支的 CI 测试通过后，自动部署到生产服务器。生产环境继续使用原有的
单机 `systemd + Nginx + PostgreSQL` 架构，不引入 Docker。

## 发布链路

```text
main push
  -> SkillHub CI
  -> npm ci + npm test
  -> git archive 生成只包含已跟踪源码的不可变压缩包
  -> 使用固定 host key 和专用部署密钥上传
  -> 服务器校验 SHA-256
  -> 安装生产依赖
  -> 部署前 pg_dump
  -> 执行幂等数据库迁移
  -> 原子切换 /opt/catsco/skillhub/app 符号链接
  -> 重启 API 和 Worker
  -> 检查内部及公网 healthz/readyz
  -> 同步 release 内 Nginx 配置并执行 nginx -t + reload
```

生产部署使用 GitHub `production` Environment，并通过并发锁保证同一时刻只有一个发布任务。
应用健康检查通过后，服务器端发布程序会把 release 内的
`infra/nginx/skillhub.conf` 同步到 `/etc/nginx/sites-available/catsco-skillhub`，执行
`nginx -t` 后 reload。这样 `/packages/*` 不会继续走旧的文件系统 `alias`，而会进入 API
执行可见性 ACL。配置切换失败会恢复部署前的 Nginx 配置，同时触发应用回滚。
部署 SSH 密钥只属于 `skillhub-deploy` 用户；该用户只能向 staging 目录写入发布包，并通过
受限的 `sudo` 命令调用服务器端发布程序。GitHub 中不保存 root 密码、数据库密码或 SkillHub
运行时 `.env`。

## GitHub Environment 配置

Environment variables：

```text
SKILLHUB_PROD_HOST
SKILLHUB_PROD_PORT
SKILLHUB_PROD_USER
SKILLHUB_PROD_URL
```

Environment secrets：

```text
SKILLHUB_PROD_SSH_KEY
SKILLHUB_PROD_KNOWN_HOSTS
```

`SKILLHUB_PROD_KNOWN_HOSTS` 必须固定服务器当前 SSH host key，不允许在 workflow 中运行
`ssh-keyscan` 后直接信任结果。

## 服务器固定组件

以下内容由服务器管理员首次安装，不随普通应用发布自动覆盖：

```text
/usr/local/sbin/deploy-catsco-skillhub
/etc/sudoers.d/catsco-skillhub-deploy
/home/skillhub-deploy/.ssh/authorized_keys
```

仓库中的 `infra/deploy/deploy-catsco-skillhub` 是服务器发布程序的受审版本。修改该文件后，
需要由服务器管理员复核并手动安装，普通 GitHub Actions 发布不能自行替换 root 级部署程序。
安装本次版本的发布程序后，后续应用发布会自动同步并校验 Nginx 配置；不应再只手动拷贝
一次配置后长期依赖旧文件。

自动部署要求 `/opt/catsco/skillhub/app` 是指向 `/opt/catsco/skillhub/releases/` 子目录的符号链接。
新服务器必须按 [首次部署文档](deployment.md)直接创建 release；已有实体 `app` 目录的旧服务器，
必须先执行文档中的一次性 bootstrap。发布程序会在安装依赖、备份和 migration 之前检查该结构，
不符合时立即停止。

## 回滚边界

部署程序在安装依赖/迁移之前，以及切换 app 链接之前，使用限时的
`systemctl show --property=Version --value` 查询运行中的 PID 1。不响应或空响应会阻止继续部署；
不会仅因其他无关 unit 导致系统处于 `degraded` 就拒绝发布。
重启服务最多等待 90 秒（随后最多 5 秒强制结束等待进程），reload 最多 30 秒；
健康检查循环整体最多 90 秒（随后最多 2 秒清理），内部 systemctl/HTTP 探针也各有限时。
结束 systemctl 客户端**不代表取消了服务管理器中已经入队的作业**。
回滚时若无法验证运行状态，日志明确报告 `runtime recovery is UNVERIFIED`，
不能将“链接已恢复”当成“服务已恢复”。此时先检查 PID 1、服务实际进程及版本，再决定是否重试。

2026-10-13/14 生产主机曾在 fwupd 生命周期期间出现 PID 1 ABRT/SEGV 和
`Freezing execution`；旧进程仍可响应 HTTP，但无法正常重启服务。部署脚本只能快速失败，
不能修复操作系统。该云主机的处置是保存日志/配置、持久 mask `fwupd.service`、
`fwupd-refresh.service`、`fwupd-refresh.timer`，定向更新 systemd/glibc 并重启验证。
这些是管理员的主机维护操作，不应让普通发布脚本自动升级操作系统或重启服务器。
不要不经评估将固件更新禁用策略套用到需要固件维护的物理主机。

发布程序在切换前保存当前 release 路径。新版本重启或健康检查失败时，会自动把 `app` 链接
切回旧 release 并再次启动服务。

数据库迁移是向前、幂等执行的，不做自动数据库降级。每次迁移前都会在
`/opt/catsco/skillhub/backups/` 生成 `pg_dump`。若未来引入破坏性 migration，必须把数据兼容、
灰度和人工恢复步骤写进该 PR，不能依赖代码链接回滚来恢复数据库。

## 手动重跑

GitHub Actions 页面可以重新运行失败的 workflow。相同 Git commit 会生成新的 release 目录，
已成功的旧 release 和数据库备份不会被覆盖。

生产日志：

```bash
sudo journalctl -u catsco-skillhub-api -n 100 --no-pager
sudo journalctl -u catsco-skillhub-worker -n 100 --no-pager
```

健康检查：

```bash
curl -fsS http://127.0.0.1:9000/healthz
curl -fsS http://127.0.0.1:9000/readyz
curl -fsS https://skillhub.catsco.fun:19990/readyz
```
