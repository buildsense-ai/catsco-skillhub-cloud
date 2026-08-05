# 云端项目目录框架

正式版采用：

- PostgreSQL 保存业务数据
- 账号密码登录 + session
- `user_roles` 控制权限
- systemd 管理 Node.js API/Worker
- Nginx 负责 HTTPS 反代和 `/packages/` 静态下载
- 本地磁盘只保存 intake/reviews/packages 文件

## 本地仓库结构

```text
catsco-skillhub-cloud/
  apps/
    api/                 # HTTP API、账号/session、审核、registry
    worker/              # 扫描、审核后打包、签名、发布
    admin/public/        # 审核员/管理员页面
    registry-edge/       # 后续高并发只读 registry 预留
  packages/
    auth/                # 密码 hash、session、RBAC
    audit/               # 审计日志和脱敏
    config/              # 环境变量读取
    database/            # PostgreSQL 存储层
    domain/              # manifest、状态机、校验工具
    object-storage/      # 本地文件存储封装
    packager/            # .skillpkg 构建
    queue/               # PostgreSQL jobs 队列
    scanner/             # zip/路径/内容安全扫描
    sdk/                 # CatsCo Agent 调用和校验 SDK
    search/              # 公开搜索
    signing/             # Ed25519 签名和验证
  infra/
    migrations/          # PostgreSQL schema
    systemd/             # 生产服务模板
    nginx/               # HTTPS 反代和 packages 静态目录
  docs/
  scripts/
```

## Linux 运行目录

```text
/opt/catsco/skillhub/
  app/                   # 本仓库代码
  storage/
    intake/              # 私有：开发者原始提交
    packages/            # 公开：已审核、已签名 .skillpkg
    reviews/             # 私有：扫描报告和审核快照
    tmp/                 # 私有：原子写入临时目录
  shared/
    .env                 # 私有环境变量
    keys/                # 私有签名密钥，公钥可公开
  logs/
  backups/
```

Nginx 只暴露：

```text
/opt/catsco/skillhub/storage/packages/
```

不要暴露 `intake/`、`reviews/`、`tmp/`、`shared/`。

## PostgreSQL 核心表

```text
users
sessions
user_roles
developer_applications
developer_profiles
skills
skill_submissions
scan_runs
reviews
package_versions
downloads
jobs
audit_logs
```

## 状态流

```text
submitted
  -> scan_pending
  -> scanning
  -> review_pending
  -> approved
  -> packaging
  -> published
```

失败和人工分支：

```text
scan_failed
changes_requested
rejected
build_failed
yanked
deprecated
```

## API 边界

账号：

```text
POST /api/auth/register
POST /api/auth/login
POST /api/auth/logout
GET  /api/auth/me
```

开发者申请：

```text
POST /api/developer-applications
GET  /api/developer-applications/me
GET  /api/admin/developer-applications
POST /api/admin/developer-applications/:id/approve
POST /api/admin/developer-applications/:id/reject
```

开发者：

```text
POST /api/developer/manifest-drafts
POST /api/developer/submissions
GET  /api/developer/submissions
GET  /api/developer/submissions/:id
```

审核员：

```text
GET  /api/reviewer/submissions
POST /api/reviewer/submissions/:id/approve
POST /api/reviewer/submissions/:id/reject
POST /api/reviewer/submissions/:id/request-changes
```

公开 Registry：

```text
GET /api/skills
GET /api/skills/:skillId
GET /api/skills/:skillId/versions
GET /api/skills/:skillId/versions/:version
GET /api/skills/:skillId/versions/:version/download
GET /api/trust/public-keys
```

