# 备份与恢复

至少备份：

```text
PostgreSQL 数据库 catsco_skillhub
/opt/catsco/skillhub/shared/.env
/opt/catsco/skillhub/shared/keys/
/opt/catsco/skillhub/storage/packages/
/opt/catsco/skillhub/storage/reviews/
/etc/systemd/system/catsco-skillhub-api.service
/etc/systemd/system/catsco-skillhub-worker.service
/etc/nginx/sites-available/catsco-skillhub
```

## 数据库备份

```bash
sudo mkdir -p /opt/catsco/skillhub/backups
PGPASSWORD='你的数据库密码' pg_dump -h 127.0.0.1 -U skillhub -d catsco_skillhub \
  > /opt/catsco/skillhub/backups/catsco_skillhub-$(date +%F).sql
```

## 文件备份

```bash
sudo tar -czf /opt/catsco/skillhub/backups/skillhub-files-$(date +%F).tar.gz \
  /opt/catsco/skillhub/shared \
  /opt/catsco/skillhub/storage/packages \
  /opt/catsco/skillhub/storage/reviews \
  /etc/systemd/system/catsco-skillhub-api.service \
  /etc/systemd/system/catsco-skillhub-worker.service \
  /etc/nginx/sites-available/catsco-skillhub
```

备份文件应同步到另一台服务器或云盘。本机备份只能解决误删，不能解决服务器损坏。

## 恢复检查

```bash
sudo chown -R skillhub:skillhub /opt/catsco/skillhub
sudo chmod 640 /opt/catsco/skillhub/shared/.env
sudo chmod 600 /opt/catsco/skillhub/shared/keys/skillhub-ed25519-private.pem
sudo chmod -R 755 /opt/catsco/skillhub/storage/packages

sudo systemctl restart catsco-skillhub-api catsco-skillhub-worker
curl -fsS http://127.0.0.1:9000/readyz
curl -fsS https://skillhub.catsco.fun:19990/api/trust/public-keys
```


