# Skill 可见范围（PR A）

PR A 为逻辑 Skill 增加三档服务端可见范围：`public`、`shared`、`private`。范围存放在 `skills`，不是 `skill_versions`，因此同一 Skill 的新版本自动继承当前范围和共享 UID 名单。

旧数据迁移到 `010_skill_visibility.sql` 后默认为 `public`，不会改变已有目录、下载和更新能力。共享授权只保存不可变的 CatsCo UID，不保存用户名；页面展示名由 CatsCo 当前资料另行提供。

## 查询规则

- 未登录用户和 Agent 只能看到 `public`。
- 登录用户可以看到公开 Skill、自己拥有的 Skill，以及 `shared` 且共享给自己 CatsCo UID 的 Skill。
- Owner 可以看到自己 Skill 的所有公开版本；管理员具有管理读取权限。
- 无权限的详情、版本和下载统一按“不存在或未发布”处理，避免泄露私有 Skill 是否存在。
- 直接访问历史 `packageUrl`（包括 `/packages/sha256/<sha>.skillpkg`）也必须通过同一 ACL；未知、已撤销或无权限的包统一返回 `404`。
- 包响应使用 `private, no-store`，避免公开缓存继续暴露后来改为共享/私有的包。
- 共享名单不随普通目录、详情或版本接口返回。

共享授权记录中的 `granted_by_user_id` 只是当前操作者的可选审计指针。操作者账号被删除时，授权规则保留，指针置空，不会阻塞账号删除（已有数据库由 `011_skill_visibility_grant_writer_delete.sql` 补齐该约束）。

## Owner 接口

`GET /api/skills/:skillId/visibility`

返回当前范围、版本号和共享 UID，仅 Owner/Admin 可读。

`PATCH /api/skills/:skillId/visibility`

```json
{
  "visibilityScope": "shared",
  "sharedUserUids": ["951", "42001"],
  "expectedRevision": 1
}
```

更新要求当前 Owner 或管理员，并使用 `expectedRevision` 做并发校验；冲突返回 `409 skill.visibility_conflict`。修改只影响之后的发现、详情、下载、添加和更新，不撤销已安装用户正在使用的内容，也不修改 BotDefinition 或运行时。

部署前执行：

```bash
npm run db:migrate
```

该迁移是加法式的；不要在 PR A 合并前单独打开 WebApp 的可见范围入口。
