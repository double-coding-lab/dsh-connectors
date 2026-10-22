# dsh-connectors

DeepSeek Harness 的 MCP 连接器插件。提供独立的侧栏面板：浏览连接器目录，一键接入 MCP Server 并完成授权与凭据保管；支持 mcpServers JSON 自定义接入、连接状态与故障诊断、示例提示词直接带入会话。MCP 连接、stdio 子进程与工具注册由 DSH 官方 dsh-mcp-client 负责，插件只做目录、凭据和界面。