# CatsCo SkillHub Cloud

这是 CatsCo Agent 的正式版 SkillHub 云端服务，按“PostgreSQL + 账号登录 + session + 角色权限 + systemd + Nginx + 本地磁盘保存发布包”的方式设计。

核心原则：

```text
人用账号密码登录
程序用系统级密钥
权限存在 PostgreSQL 的 user_roles 表
审核前内容不公开
发布包 .skillpkg 不可覆盖
Agent 安装前必须校验 checksum 和 signature
```

## 正式流程

```text
用户注册/登录
  -> 普通 user
  -> 申请成为开发者
  -> 管理员审核通过
  -> user_roles 增加 developer
  -> 开发者上传 skill
  -> Worker 扫描
  -> reviewer/admin 审核
  -> Worker 打包 .skillpkg
  -> Ed25519 签名 + SHA-256 checksum
  -> 写入 Registry
  -> CatsCo Agent 搜索、下载、校验、安装
```

## 已实现内容

- `apps/api`：账号注册/登录/session、开发者申请、提交、审核、公开搜索、下载、公钥接口。
- `apps/worker`：后台扫描、审核后打包、签名、发布。
- `apps/admin/public`：账号登录式审核后台，不再手动填写 reviewer/admin token。
- `packages/database`：PostgreSQL 存储层。
- `infra/migrations`：PostgreSQL schema。
- `packages/scanner`：路径穿越、zip-slip、prompt injection、密钥读取、shell/network/install hook 检测。
- `packages/packager`：生成不可变 `.skillpkg`。
- `packages/signing`：Ed25519 签名和公钥发布。
- `/api/trust/public-keys`：返回 root 签发过证书的 package signing key，供 Agent 验证信任链。

## 关键 API

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

管理员：

```text
GET  /api/admin/users
POST /api/admin/users/:id/roles
DELETE /api/admin/users/:id/roles/:role
GET  /api/admin/package-versions
POST /api/admin/package-versions/:id/yank
GET  /api/admin/audit-logs
```

公开 Registry：

```text
GET /api/skills?q=合同审查
GET /api/skills/:skillId
GET /api/skills/:skillId/versions
GET /api/skills/:skillId/versions/:version
GET /api/skills/:skillId/versions/:version/download
GET /api/trust/public-keys
```

Bot 私有备份（`Authorization: ApiKey ...` 与 `X-CatsCo-Bot-Id`）：

```text
PUT /api/bot/private-skill-packages
GET /api/bot/skill-packages/:skillId/versions/:version
POST /api/bot/private-skill-metadata
POST /api/bot/private-skill-history
```

私有版本不可覆盖、按真实 Bot 身份隔离，且不会出现在公开 Registry。元数据批量接口同样使用 Bot API key 鉴权，只返回请求 Bot 所拥有版本的 `skillId`、内部精确 `version`、`displayName`，以及可选的只读 `revisionNumber`、`changeSource` 和 `lastChangedAt`。这里记录的是该内容版本最近一次变更的来源与时间，不伪造成原始作者；没有 mutation 的历史 Runtime 备份明确归因为 Bot 自动同步。mutation actor UID 仅在服务端持久化，不经此接口返回。接口不返回包内容、哈希、来源路径、Git 信息、对话标识或凭据。详细灰度与回滚顺序见
[docs/operations/private-bot-skills.md](docs/operations/private-bot-skills.md)。

历史接口接收单个私有 `skillId`，按内容修订号倒序返回只读元数据，并使用 `beforeRevisionNumber` 游标分页。它列出的是不可变内容版本，不代表每一次重新启用事件；同一内容被再次启用时仍保留原修订号，并以最新已记录的变更来源与时间展示。不存在或不属于当前 Bot 的私有引用统一返回空列表，避免跨 Bot 探测。

## 生产部署

详见：

- [docs/operations/postgresql.md](docs/operations/postgresql.md)
- [docs/operations/deployment.md](docs/operations/deployment.md)
- [docs/operations/automatic-deployment.md](docs/operations/automatic-deployment.md)
- [docs/operations/env-vars.md](docs/operations/env-vars.md)

部署后先运行：

```bash
cd /opt/catsco/skillhub/app
npm install --omit=dev
npm run db:migrate
SKILLHUB_ADMIN_EMAIL=admin@example.com SKILLHUB_ADMIN_PASSWORD='strong-password' npm run admin:create
```

## 本地检查

没有配置 `SKILLHUB_TEST_DATABASE_URL` 时，PostgreSQL 集成测试会跳过。

```powershell
cd E:\SkillHub\catsco-skillhub-cloud
npm.cmd test
Get-ChildItem -Recurse -Filter *.js | ForEach-Object { node --check $_.FullName }
```
