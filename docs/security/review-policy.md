# Skill 审核策略

首版采用保守策略：扫描出现 `high` 或 `critical` 风险时，审核接口直接拒绝通过。

## 自动阻断

- 修改、覆盖或绕过 system/developer prompt。
- 要求泄露上下文、系统提示词、开发者消息。
- 读取 `.env`、SSH 私钥、API key、token、浏览器 cookie。
- 任意 shell、PowerShell、`child_process`、`exec`、`spawn`。
- 任意网络访问、动态下载执行代码。
- 安装生命周期 hook，例如 `postinstall`、`prepare`。
- zip 路径穿越、绝对路径、Windows drive path、符号链接。
- 嵌套压缩包和可执行文件。

## 审核通过条件

- `skill.json` 已由服务端规范化。
- 入口文件存在，默认是 `SKILL.md`。
- 权限声明和实际内容一致。
- 扫描结果没有 `high` 或 `critical`。
- 审核员不是提交者本人。
- 发布版本没有重复。

## 发布边界

- `submitted`、`scan_failed`、`review_pending`、`approved` 都不会公开。
- 只有 `published` 状态会进入 `/api/skills` 搜索结果。
- `.skillpkg` 一旦生成，不允许覆盖。
- 下架使用 `yanked`，不要直接删除历史包。
