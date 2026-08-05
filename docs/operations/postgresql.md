# PostgreSQL 安装与初始化

以下以 Ubuntu/Debian 为例。

## 1. 安装 PostgreSQL

```bash
sudo apt update
sudo apt install -y postgresql postgresql-contrib

sudo systemctl enable postgresql
sudo systemctl start postgresql
sudo systemctl status postgresql --no-pager
```

## 2. 创建数据库和用户

```bash
sudo -u postgres psql
```

进入 `psql` 后执行：

```sql
CREATE USER skillhub WITH PASSWORD '请换成很强的数据库密码';
CREATE DATABASE catsco_skillhub OWNER skillhub;
GRANT ALL PRIVILEGES ON DATABASE catsco_skillhub TO skillhub;
\q
```

## 3. 测试连接

```bash
psql "postgresql://skillhub:你的数据库密码@127.0.0.1:5432/catsco_skillhub" -c "select now();"
```

如果能返回时间，说明数据库连接正常。

## 4. 写入 .env

```env
SKILLHUB_DATABASE_URL=postgresql://skillhub:你的数据库密码@127.0.0.1:5432/catsco_skillhub
```

## 5. 执行迁移

```bash
cd /opt/catsco/skillhub/app
npm install --omit=dev
npm run db:migrate
```

## 6. 创建第一个管理员

```bash
cd /opt/catsco/skillhub/app
SKILLHUB_ADMIN_EMAIL=admin@example.com \
SKILLHUB_ADMIN_PASSWORD='请换成很强的管理员密码' \
SKILLHUB_ADMIN_NAME='SkillHub Admin' \
npm run admin:create
```

这个账号会被授予：

```text
admin
reviewer
```

