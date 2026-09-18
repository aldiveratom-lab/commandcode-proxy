## Summary

### English
Adds a reusable Vue 3 + TypeScript management console UI for CommandCode-compatible gateways. The UI includes responsive navigation, overview metrics, upstream account management, model allowlists, client API key lifecycle, streaming diagnostics, audit views, and security settings.

### 中文
新增可复用的 Vue 3 + TypeScript 管理控制台界面，适用于兼容 CommandCode 的网关。包含响应式导航、总览指标、上游账号管理、模型白名单、客户端 API 密钥生命周期、流式诊断、审计视图和安全设置。

## Scope

- Frontend-only contribution under `frontend/`.
- Backend/API integration is configurable through `VITE_API_PREFIX` and defaults to `/api`.
- No deployment configuration, credentials, infrastructure addresses, private paths, or production data are included.
- No generated build artifacts are included.

## Verification / 验证

- `pnpm --dir frontend build` ✅
- TypeScript project check (`vue-tsc -b`) ✅
- Vite production build ✅
- No real browser or external service was used for verification.

## Security / 安全

- Credentials are never hard-coded.
- API keys are only displayed through the backend-provided one-time response.
- Requests use same-origin credentials and CSRF headers supplied by the API session.
- User-provided text is not written to audit output by the frontend.

## Review notes

This PR intentionally does not change the existing proxy runtime or server routing. It is a UI contribution intended to be adapted to the host project's API conventions.

## 中文审阅说明

本 PR 有意不修改现有代理运行时和服务端路由，仅提供前端控制台界面，方便宿主项目按自身 API 约定集成。

Closes: N/A
