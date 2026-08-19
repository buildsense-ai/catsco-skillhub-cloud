# Bot 私有 Skill 灰度与回滚

私有 Skill 接口为 XiaoBa 的 Bot 工作区提供自动备份和新设备恢复。它与公开分享是两条不同链路：

```text
自动同步 -> 私有、按 Bot 隔离、内容不可覆盖
用户分享 -> 公开 Registry、签名发布
```

第二阶段 C1/C2 mutation writer 是第三条、默认关闭的内部链路：

```text
C1 trusted mutation -> SkillHub immutable Git version -> future BotDefinition/Runtime activation
```

它不复用 Bot API key 上传接口，也不会因为开启备份接口而自动开放聊天修改。契约和请求事实见
`docs/api/private-mutation-writer.md`。在候选工作区、Runtime 原子激活和跨仓回归测试完成前，生产环境必须保持
`SKILLHUB_MUTATION_WRITER_ENABLED=false`。

## 上线顺序

1. 先部署 CatsCo `GET /api/bot/identity`。接口只能返回已鉴权 Bot 的 UID，不返回模型配置或密钥。
2. 备份数据库并执行 `npm run db:migrate`，确认 migration 003 成功。
3. 使用独立测试数据库运行：

   ```bash
   SKILLHUB_TEST_DATABASE_URL='postgresql://...' npm test
   ```

4. 设置 `SKILLHUB_PRIVATE_SKILLS_READ_ENABLED=true`，保持写入关闭，验证 `/readyz`。
5. 配置少量 `SKILLHUB_PRIVATE_SKILL_ALLOWED_BOT_IDS`，再开启写入。
6. 验证上传幂等、同 Bot 下载、跨 Bot 返回 404、本地修改产生新版本、旧版本仍可下载。
7. 逐步扩展 allowlist；确认稳定后才考虑设置
   `SKILLHUB_PRIVATE_SKILL_ALLOW_ALL_BOTS=true` 对全部已鉴权 Bot 开放。

## 回滚顺序

1. 先设置 `SKILLHUB_PRIVATE_SKILLS_WRITE_ENABLED=false`，阻止新上传。
2. 保持 `SKILLHUB_PRIVATE_SKILLS_READ_ENABLED=true`，让已写入 Definition 的引用仍可恢复。
3. 回滚 XiaoBa 或 CatsCo 应用代码。
4. migration 003 只新增表；应用回滚期间保留表和历史包，不执行物理删除。

## 数据与安全边界

- 身份由 SkillHub 转发 Bot API Key 到 CatsCo `/api/bot/identity` 后取得。
- 数据库查询同时绑定 CatsCo authority、真实 Bot UID、Skill ID 和版本。
- 私有引用为随机不透明 ID，不包含 Bot UID、localSkillId 或内容哈希。
- 包写入私有目录，不放入 Nginx 公开的 `/packages` 路径。
- 服务端重新校验路径、Base64、文件哈希、聚合哈希、静态扫描和敏感内容。
- 历史版本不可变；删除 BotDefinition 引用不物理删除历史包。
