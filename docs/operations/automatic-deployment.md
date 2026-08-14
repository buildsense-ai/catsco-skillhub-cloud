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
```

生产部署使用 GitHub `production` Environment，并通过并发锁保证同一时刻只有一个发布任务。
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

自动部署要求 `/opt/catsco/skillhub/app` 是指向 `/opt/catsco/skillhub/releases/` 子目录的符号链接。
新服务器必须按 [首次部署文档](deployment.md)直接创建 release；已有实体 `app` 目录的旧服务器，
必须先执行文档中的一次性 bootstrap。发布程序会在安装依赖、备份和 migration 之前检查该结构，
不符合时立即停止。

## 回滚边界

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
