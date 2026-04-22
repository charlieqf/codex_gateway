# ADR 0002: OpenAI Codex 作为第一个 Provider 验证对象

## 状态

Accepted for Phase 0

## 背景

需求文档要求 provider-neutral，但 MVP 只覆盖一个已验证 provider。用户明确希望以 ChatGPT/Codex 订阅作为示例，并可使用自己的订阅测试。

## 决策

Phase 0 以 OpenAI Codex / ChatGPT subscription path 作为第一 provider 验证对象。

## 约束

- 只使用官方支持的 Codex CLI/SDK/App Server 登录和调用路径。
- 不复制浏览器 cookie。
- 不解析或依赖非公开 token 格式。
- ChatGPT/Codex 原始登录态只放在服务端受控 `CODEX_HOME`。

## 退出条件

若 Phase 0 证明 ChatGPT subscription path 不适合服务端托管网关，MVP provider 切换为 OpenAI API key path。网关 access credential、subject、scope、session、scheduler 设计保持不变。

