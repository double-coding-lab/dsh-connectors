# Providers

每个子目录是一个内置连接器，`provider.json` 是唯一信源，`icon.svg|png|webp` 可选。修改后运行：

```bash
npm run providers:icons   # 重新生成 src/client/provider-icons.generated.ts
npm run check             # 类型检查 + 构建 + provider 校验
```

当前内置 27 个：

| id | auth | 分类 |
| --- | --- | --- |
| github | bearer | 开发工具 |
| linear | oauth2（DCR） | 项目管理 |
| neon | oauth2（DCR） | 数据库 |
| supabase | oauth2（DCR） | 数据库 |
| gitlab | oauth2 | 开发工具 |
| gitlab-self-hosted | oauth2（instance） | 开发工具 |
| context7 | none | 知识检索 |
| microsoft-learn | none | 知识检索 |
| deepwiki | none | 知识检索 |
| cloudflare-docs | none | 开发工具 |
| posthog | oauth2（DCR，无 scope） | 数据分析 |
| grafana | bearer | 安全运维 |
| postman | oauth2 | 开发工具 |
| sourcegraph | bearer | 开发工具 |
| circleci | oauth2 | 开发工具 |
| sentry | oauth2 | 安全运维 |
| notion | oauth2 | 办公协作 |
| yunxiao | oauth2 | 开发工具 |
| gitee | bearer | 开发工具 |
| tencent-yuanbao-search | bearer | 知识检索 |
| amap | none（instance） | 知识检索 |
| tencent-docs | oauth2（DCR） | 办公协作 |
| tianyancha | oauth2（DCR） | 数据分析 |
| qcc | oauth2（DCR，instance 预置 10 个数据域） | 数据分析 |
| firecrawl | oauth2（DCR） | 知识检索 |
| tavily | oauth2（DCR） | 知识检索 |
| baidu-netdisk | bearer（SSE） | 办公协作 |

钉钉、飞书、腾讯会议、企业微信、Hugging Face、Agent Mail 不在内置 MCP 目录：官方推荐使用 CLI + Skills（`dws` / `lark-cli` / `tmeet` / `wecom-cli` / `hf` / `agently-cli`），不走远程 MCP；有真实 MCP 地址的场景请用自定义连接器导入。

新增或修改 provider 的完整规则见 [CONTRIBUTING.md](../CONTRIBUTING.md)。
