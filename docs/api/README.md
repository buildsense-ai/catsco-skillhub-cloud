# API

正式版 API 不使用 `/api/v1` 前缀，统一按业务域分组。

## Auth

```http
POST /api/auth/register
POST /api/auth/login
POST /api/auth/logout
GET  /api/auth/me
```

登录成功后服务端设置 `catsco_session` Cookie。后续请求由 Cookie 识别当前用户。

## Developer Applications

```http
POST /api/developer-applications
GET  /api/developer-applications/me

GET  /api/admin/developer-applications?status=pending
POST /api/admin/developer-applications/:applicationId/approve
POST /api/admin/developer-applications/:applicationId/reject
```

## Developer

```http
POST /api/developer/manifest-drafts
POST /api/developer/submissions
GET  /api/developer/submissions
GET  /api/developer/submissions/:submissionId
```

文件清单提交：

```json
{
  "source": {
    "type": "files",
    "files": [
      { "path": "SKILL.md", "content": "# 合同审查助手..." },
      { "path": "README.md", "content": "..." }
    ]
  },
  "manifest": {
    "displayName": "合同审查助手",
    "version": "1.0.0",
    "description": "用于审查合同条款、付款条件、违约责任和法务风险。",
    "author": { "name": "CatsCo Developer" },
    "license": "MIT",
    "permissions": {
      "filesystem": "user_selected",
      "network": "none",
      "shell": "none",
      "secrets": "none"
    }
  }
}
```

## Reviewer

```http
GET  /api/reviewer/submissions
GET  /api/reviewer/submissions?status=review_pending
POST /api/reviewer/submissions/:submissionId/approve
POST /api/reviewer/submissions/:submissionId/reject
POST /api/reviewer/submissions/:submissionId/request-changes
```

## Admin

```http
GET    /api/admin/users
POST   /api/admin/users/:userId/roles
DELETE /api/admin/users/:userId/roles/:role

GET  /api/admin/package-versions?status=published&q=合同
POST /api/admin/package-versions/:packageVersionId/yank

GET  /api/admin/audit-logs?action=package.yanked&resourceType=packageVersion
```

## Public Registry

```http
GET /api/skills?q=合同审查&agent_version=1.14.0&platform=windows
GET /api/skills/:skillId
GET /api/skills/:skillId/versions
GET /api/skills/:skillId/versions/:version
GET /api/skills/:skillId/versions/:version/download
GET /api/trust/public-keys
```


