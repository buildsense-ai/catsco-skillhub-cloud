# SkillHub 源码基线

本仓库保存 CatsCo SkillHub 服务端的可重建源码，不保存生产数据库、Skill 内容包、CAS 对象、运行日志或任何生产凭据。

## 来源

- 归档日期：2026-08-05
- 服务器 release：`20260804-a86df453f88ff199`
- 服务入口：`apps/api/server.js`
- Worker 入口：`apps/worker/worker.js`
- 运行时：Node.js 22
- 数据库迁移：`001_initial` 至 `005_git_backed_skill_versions`

源码来自服务器当前实际运行的 release，并经过脱敏后导入。未把历史 tar 包、`node_modules`、运行目录或生产数据纳入 Git 历史。

## 已完成的验证

- 服务器 release 文件清单逐文件 SHA-256 比对：83/83 一致。
- SkillHub 集成测试：18 项通过，2 项因未配置 PostgreSQL 测试夹具而跳过，0 项失败。
- 在隔离 PostgreSQL 数据库中按 001–005 顺序执行迁移成功，预期表全部创建；验证库随后已删除。
- 生产服务只读检查：`/healthz` 和 `/readyz` 均返回正常。
- 源码中未发现私钥内容。

## 运行配置

生产配置由服务器外部的环境文件和持久化卷提供。部署时请根据 `.env.example` 配置真实环境变量，并将密钥、数据库连接串、Skill 包和 CAS 数据放在仓库之外。

本仓库当前只配置测试 CI，不配置自动生产部署。生产发布仍需经过团队明确的发布流程和回滚确认。
