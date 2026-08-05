# 无 Docker 生产部署

部署目录：

```text
/opt/catsco/skillhub/
```

## 1. 创建用户和目录

```bash
sudo useradd --system --home /opt/catsco/skillhub --shell /usr/sbin/nologin skillhub || true

sudo mkdir -p /opt/catsco/skillhub/{app,storage/{intake,packages,reviews,tmp},shared/keys,logs,backups}
sudo chown -R skillhub:skillhub /opt/catsco/skillhub

sudo chmod 755 /opt/catsco
sudo chmod 755 /opt/catsco/skillhub
sudo chmod 750 /opt/catsco/skillhub/app
sudo chmod 750 /opt/catsco/skillhub/shared
sudo chmod 700 /opt/catsco/skillhub/shared/keys
sudo chmod 700 /opt/catsco/skillhub/storage/intake
sudo chmod 755 /opt/catsco/skillhub/storage/packages
sudo chmod 700 /opt/catsco/skillhub/storage/reviews
sudo chmod 700 /opt/catsco/skillhub/storage/tmp
```

## 2. 上传项目代码

```bash
rsync -av --delete ./catsco-skillhub-cloud/ root@YOUR_SERVER:/opt/catsco/skillhub/app/
ssh root@YOUR_SERVER "sudo chown -R skillhub:skillhub /opt/catsco/skillhub/app"
```

## 3. 安装 Node.js 和依赖

需要 Node.js 22 或更高版本。

```bash
node -v

cd /opt/catsco/skillhub/app
sudo -u skillhub npm install --omit=dev
```

## 4. 安装 PostgreSQL

见 [postgresql.md](postgresql.md)。

简版：

```bash
sudo apt update
sudo apt install -y postgresql postgresql-contrib
sudo systemctl enable postgresql
sudo systemctl start postgresql

sudo -u postgres psql
```

```sql
CREATE USER skillhub WITH PASSWORD '请换成很强的数据库密码';
CREATE DATABASE catsco_skillhub OWNER skillhub;
GRANT ALL PRIVILEGES ON DATABASE catsco_skillhub TO skillhub;
\q
```

## 5. 创建 .env

先生成系统级密钥：

```bash
cd /opt/catsco/skillhub/app
node scripts/generate-secrets.js
```

写入配置：

```bash
sudo nano /opt/catsco/skillhub/shared/.env
```

模板：

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

SKILLHUB_SESSION_SECRET=generate-secrets输出的SESSION_SECRET
SKILLHUB_AGENT_CLIENT_SECRET=generate-secrets输出的AGENT_CLIENT_SECRET
SKILLHUB_ALLOWED_ORIGINS=https://skillhub.catsco.fun:19990
SKILLHUB_COOKIE_DOMAIN=
SKILLHUB_COOKIE_SECURE=true

SKILLHUB_ROOT_KEY_ID=catsco-root-prod-2026-01
SKILLHUB_ROOT_PRIVATE_KEY_PATH=/opt/catsco/skillhub/shared/keys/catsco-root-ed25519-private.pem
SKILLHUB_ROOT_PUBLIC_KEY_PATH=/opt/catsco/skillhub/shared/keys/catsco-root-ed25519-public.pem
SKILLHUB_ALLOW_AUTO_ROOT_KEYGEN=false

SKILLHUB_SIGNING_KEY_ID=catsco-skillhub-prod-2026-01
SKILLHUB_SIGNING_PRIVATE_KEY_PATH=/opt/catsco/skillhub/shared/keys/skillhub-ed25519-private.pem
SKILLHUB_SIGNING_PUBLIC_KEY_PATH=/opt/catsco/skillhub/shared/keys/skillhub-ed25519-public.pem
SKILLHUB_SIGNING_CERTIFICATE_PATH=/opt/catsco/skillhub/shared/keys/skillhub-signing-certificate.json
SKILLHUB_SIGNING_CERTIFICATE_EXPIRES_AT=2027-01-01T00:00:00.000Z
SKILLHUB_ALLOW_AUTO_KEYGEN=false

SKILLHUB_UPLOAD_MAX_BYTES=52428800
SKILLHUB_MAX_FILES=500
SKILLHUB_MAX_EXPANDED_BYTES=104857600
SKILLHUB_MAX_SINGLE_FILE_BYTES=5242880
SKILLHUB_MAX_PATH_LENGTH=180
SKILLHUB_MAX_PATH_DEPTH=12

SKILLHUB_WORKER_POLL_MS=3000
SKILLHUB_WORKER_ID=skillhub-worker-1
```

权限：

```bash
sudo chown skillhub:skillhub /opt/catsco/skillhub/shared/.env
sudo chmod 640 /opt/catsco/skillhub/shared/.env
```

## 6. 执行数据库迁移

```bash
cd /opt/catsco/skillhub/app
sudo -u skillhub bash -lc 'set -a; source /opt/catsco/skillhub/shared/.env; set +a; npm run db:migrate'
```

## 7. 生成 root 密钥和发布签名密钥

先生成 root key。root private key 是信任根，生产环境应严格备份和限制访问：

```bash
cd /opt/catsco/skillhub/app
sudo -u skillhub bash -lc 'set -a; source /opt/catsco/skillhub/shared/.env; set +a; npm run keys:generate-root'
```

命令会输出 root public key。这个 public key 需要内置进 CatsCo Agent 的 `trusted-keys.ts`，随 Agent 安装包发布。

再生成日常发布包使用的 signing key：

```bash
cd /opt/catsco/skillhub/app
sudo -u skillhub bash -lc 'set -a; source /opt/catsco/skillhub/shared/.env; set +a; node scripts/generate-signing-key.js'
sudo -u skillhub bash -lc 'set -a; source /opt/catsco/skillhub/shared/.env; set +a; npm run keys:issue-certificate'

sudo chmod 600 /opt/catsco/skillhub/shared/keys/catsco-root-ed25519-private.pem
sudo chmod 644 /opt/catsco/skillhub/shared/keys/catsco-root-ed25519-public.pem
sudo chmod 600 /opt/catsco/skillhub/shared/keys/skillhub-ed25519-private.pem
sudo chmod 644 /opt/catsco/skillhub/shared/keys/skillhub-ed25519-public.pem
sudo chmod 644 /opt/catsco/skillhub/shared/keys/skillhub-signing-certificate.json
sudo chown -R skillhub:skillhub /opt/catsco/skillhub/shared/keys
```

API 服务运行时只需要 root public key、package signing key 和 `skillhub-signing-certificate.json`；root private key 只在初始化或轮换 signing key 时使用。

## 8. 创建第一个管理员账号

```bash
cd /opt/catsco/skillhub/app
sudo -u skillhub bash -lc 'set -a; source /opt/catsco/skillhub/shared/.env; set +a; SKILLHUB_ADMIN_EMAIL=admin@example.com SKILLHUB_ADMIN_PASSWORD="请换成很强的管理员密码" SKILLHUB_ADMIN_NAME="SkillHub Admin" npm run admin:create'
```

## 9. 安装 systemd 服务

```bash
sudo cp /opt/catsco/skillhub/app/infra/systemd/catsco-skillhub-api.service /etc/systemd/system/
sudo cp /opt/catsco/skillhub/app/infra/systemd/catsco-skillhub-worker.service /etc/systemd/system/

sudo systemctl daemon-reload
sudo systemctl enable catsco-skillhub-api catsco-skillhub-worker
sudo systemctl start catsco-skillhub-api catsco-skillhub-worker
```

检查：

```bash
sudo systemctl status catsco-skillhub-api --no-pager
sudo systemctl status catsco-skillhub-worker --no-pager
sudo journalctl -u catsco-skillhub-api -n 100 --no-pager
sudo journalctl -u catsco-skillhub-worker -n 100 --no-pager
curl -fsS http://127.0.0.1:9000/healthz
curl -fsS http://127.0.0.1:9000/readyz
```

## 10. 配置 Nginx 和 HTTPS

```bash
sudo cp /opt/catsco/skillhub/app/infra/nginx/skillhub.conf /etc/nginx/sites-available/catsco-skillhub
sudo ln -s /etc/nginx/sites-available/catsco-skillhub /etc/nginx/sites-enabled/catsco-skillhub
sudo nano /etc/nginx/sites-available/catsco-skillhub
sudo nginx -t
sudo systemctl reload nginx
```

Certbot（80/443 不可用时使用人工 DNS-01）：

```bash
sudo certbot certonly \
  --manual \
  --preferred-challenges dns \
  --cert-name skillhub.catsco.fun \
  -d skillhub.catsco.fun
```

按 Certbot 提示在 DNS 中添加
`_acme-challenge.skillhub.catsco.fun` TXT 记录。人工 DNS-01 证书不能无人值守
续期；应在到期前至少 30 天重复上述流程，或配置 DNS API 自动化。

## 11. 上线后验证

```bash
curl -fsS https://skillhub.catsco.fun:19990/healthz
curl -fsS https://skillhub.catsco.fun:19990/readyz
curl -fsS 'https://skillhub.catsco.fun:19990/api/skills?q=合同审查'
curl -fsS https://skillhub.catsco.fun:19990/api/trust/public-keys
```

后台页面：

```text
https://skillhub.catsco.fun:19990/admin/
```

