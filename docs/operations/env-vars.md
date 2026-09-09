# 环境变量

生产环境文件建议放在：

```text
/opt/catsco/skillhub/shared/.env
```

不要放在 Nginx 公开目录，也不要提交到 Git。

## 必填

```env
NODE_ENV=production
SKILLHUB_HOST=127.0.0.1
SKILLHUB_PORT=9000
SKILLHUB_PUBLIC_BASE_URL=https://skillhub.catsco.fun:19990
SKILLHUB_PACKAGE_BASE_URL=https://skillhub.catsco.fun:19990/packages
SKILLHUB_ROOT=/opt/catsco/skillhub
SKILLHUB_STORAGE_ROOT=/opt/catsco/skillhub/storage
SKILLHUB_LOGS_ROOT=/opt/catsco/skillhub/logs
SKILLHUB_SHARED_ROOT=/opt/catsco/skillhub/shared
SKILLHUB_DATABASE_URL=postgresql://skillhub:你的数据库密码@127.0.0.1:5432/catsco_skillhub
SKILLHUB_ALLOWED_ORIGINS=https://skillhub.catsco.fun:19990
```

## Session 与程序密钥

```env
SKILLHUB_SESSION_SECRET=至少64位随机字符串
SKILLHUB_AGENT_CLIENT_SECRET=官方Agent程序调用云端时使用的系统级密钥
SKILLHUB_COOKIE_DOMAIN=
SKILLHUB_COOKIE_SECURE=true
```

使用下面命令生成：

```bash
node scripts/generate-secrets.js
```

这里不再配置 `SKILLHUB_DEVELOPER_TOKEN`、`SKILLHUB_REVIEWER_TOKEN`、`SKILLHUB_ADMIN_TOKEN`。真人用户权限存在 PostgreSQL 的 `user_roles` 表里。

## Bot 私有 Skill

生产环境默认关闭私有 Skill 读写。先部署 CatsCo 的 `GET /api/bot/identity`，再执行
SkillHub migration 003，最后按 Bot UID 灰度开启：

```env
SKILLHUB_CATSCO_BASE_URL=https://app.catsco.cc
SKILLHUB_CATSCO_AUTH_TIMEOUT_MS=8000

SKILLHUB_PRIVATE_SKILLS_READ_ENABLED=true
SKILLHUB_PRIVATE_SKILLS_HISTORY_ENABLED=true
SKILLHUB_PRIVATE_SKILLS_WRITE_ENABLED=false
SKILLHUB_PRIVATE_SKILL_ALLOWED_BOT_IDS=10001,10002
SKILLHUB_PRIVATE_SKILL_ALLOW_ALL_BOTS=false

SKILLHUB_PRIVATE_MAX_CONCURRENT_UPLOADS=2
SKILLHUB_PRIVATE_MAX_UPLOADS_PER_MINUTE=300
SKILLHUB_PRIVATE_MAX_FILES=200
SKILLHUB_PRIVATE_MAX_SINGLE_FILE_BYTES=2097152
SKILLHUB_PRIVATE_MAX_TOTAL_BYTES=20971520
SKILLHUB_PRIVATE_MAX_REQUEST_BYTES=31457280
SKILLHUB_PRIVATE_MAX_VERSIONS_PER_BOT=2000
SKILLHUB_PRIVATE_MAX_BYTES_PER_BOT=2147483648

# Dormant CatsCo C1 mutation writer. Keep disabled until the coordinator,
# candidate workspace, and runtime activation path are deployed together.
SKILLHUB_MUTATION_WRITER_ENABLED=false
SKILLHUB_MUTATION_WRITER_SECRET=至少32位的独立服务间密钥
SKILLHUB_MUTATION_WRITER_MAX_REQUEST_BYTES=31457280
```

鉴权以 CatsCo 返回的真实 Bot UID 为准，`X-CatsCo-Bot-Id` 只用于绑定校验，不能作为身份来源。
空 allowlist 默认拒绝全部 Bot；只有显式设置 `SKILLHUB_PRIVATE_SKILL_ALLOW_ALL_BOTS=true`
才会全量开放。
回滚时先关闭 `WRITE`，继续保留 `READ`，否则已有 BotDefinition 引用无法恢复。

## 签名

```env
SKILLHUB_ROOT_KEY_ID=catsco-root-prod-2026-01
SKILLHUB_ROOT_PRIVATE_KEY_PATH=/opt/catsco/skillhub/shared/keys/catsco-root-ed25519-private.pem
SKILLHUB_ROOT_PUBLIC_KEY_PATH=/opt/catsco/skillhub/shared/keys/catsco-root-ed25519-public.pem
SKILLHUB_ALLOW_AUTO_ROOT_KEYGEN=false

SKILLHUB_SIGNING_KEY_ID=catsco-skillhub-prod-2026-01
SKILLHUB_SIGNING_PRIVATE_KEY_PATH=/opt/catsco/skillhub/shared/keys/skillhub-ed25519-private.pem
SKILLHUB_SIGNING_PUBLIC_KEY_PATH=/opt/catsco/skillhub/shared/keys/skillhub-ed25519-public.pem
SKILLHUB_SIGNING_CERTIFICATE_PATH=/opt/catsco/skillhub/shared/keys/skillhub-signing-certificate.json
SKILLHUB_SIGNING_CERTIFICATE_ARCHIVE_DIR=/opt/catsco/skillhub/shared/keys/signing-certificates
SKILLHUB_SIGNING_CERTIFICATE_EXPIRES_AT=2027-01-01T00:00:00.000Z
SKILLHUB_ALLOW_AUTO_KEYGEN=false
```

`SKILLHUB_ROOT_*` 是官方信任根。云端用 root private key 给日常 package signing public key 签发证书；本地 Agent 内置 root public key 后，才能确认 `/api/trust/public-keys` 返回的 signing key 是官方授权的。

生产运行时会把每次成功签发、验证过的证书保存到 `SKILLHUB_SIGNING_CERTIFICATE_ARCHIVE_DIR`。历史包按其签名 `keyId` 读取仍在有效期内的 root-signed 证书，因此轮换当前 signing key 不会立即破坏旧包恢复。证书归档必须与包文件一起持久化和备份；旧证书到期前应为相同旧公钥续签，泄漏的 key 则必须撤销而不是续签。root private key 只在执行 `npm run keys:issue-certificate` 或密钥轮换时使用。

## 限制

```env
SKILLHUB_UPLOAD_MAX_BYTES=52428800
SKILLHUB_MAX_FILES=500
SKILLHUB_MAX_EXPANDED_BYTES=104857600
SKILLHUB_MAX_SINGLE_FILE_BYTES=5242880
SKILLHUB_MAX_PATH_LENGTH=180
SKILLHUB_MAX_PATH_DEPTH=12
```
