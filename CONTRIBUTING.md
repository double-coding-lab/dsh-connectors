# 贡献 Provider

`dsh-connectors` 的内置 provider 是**纯数据**：新增一个 provider 只需要加一个目录，不需要改核心代码。契约文件是 [`schema/provider.schema.json`](schema/provider.schema.json)。

## 我们接受什么

- 厂商官方的远程 MCP 服务；普通 provider 地址必须是 `https://`。
- 需要用户填写完整 MCP 地址的 provider 使用 `instance` 描述，地址在运行时由用户提供（可 https/http/内网），`auth` 可以是四类中的任意一种。
- `auth` 四选一：`none`、`bearer`、`header`、`oauth2`。
- provider 目录内的静态描述、示例与可选图标。
- 真实凭据下验证过能连上并注册工具。

## 我们不接受什么

- provider 携带可执行代码、构建脚本或运行时注入逻辑。
- 把 token / client secret / 固定内网地址写进 `provider.json`。
- 非 `instance` 的 `http://` 地址、代理服务或非官方转接端点（这类场景请使用面板里的「自定义连接器」导入）。
- 遥测、上报、远程配置。

## 目录结构

```text
providers/
  acme/
    provider.json   # 必需
    icon.svg        # 可选，也支持 icon.png / icon.webp
```

- `provider.json` 的 `id` 必须与目录名一致。
- `serverName` 缺省等于 `id`，必须全局唯一（决定工具前缀 `mcp__<serverName>__`）。
- 图标建议 24×24 的 SVG；没有图标时客户端用首字母色块兜底。

## 快速开始

```bash
npm run provider:new -- acme --auth bearer --name "Acme"
# 编辑 providers/acme/provider.json，替换 TODO 与示例地址
# 可选：放入 providers/acme/icon.svg
npm run check
```

`npm run check` 会依次执行类型检查、构建、provider 校验与服务地址/契约测试（重复 id / serverName、字段缺失、URL、排序等）。

## 通用服务地址 provider（instance）

如果服务需要用户填写**完整的 MCP 地址**（自建 GitLab、高德等），在 provider 中增加 `instance` 描述，并且不要设置 `server.url`：

```json
{
  "instance": {
    "label": "服务地址",
    "placeholder": "https://example.com/mcp",
    "hint": "填写完整的 MCP 端点；不要包含账号密码或锚点。",
    "help": {
      "url": "https://example.com/docs/mcp",
      "label": "查看接入指引",
      "hint": "在控制台创建服务后复制地址。"
    }
  },
  "server": {
    "serverName": "example",
    "transport": "streamable-http"
  },
  "auth": { "type": "none" }
}
```

规则：

- `auth.oauth2` 还支持 `registration: "user"`（用户在面板填写 AppKey/SecretKey）配 `endpoints`、`authorizeParams`、`tokenMethod: "GET"`、`pkce: false`，用于不支持 DCR、且由用户自建应用的服务。
- `server.transport` 支持 `streamable-http` 与旧版 `sse`；`sse` 地址同样必须是 https，由插件内置的 stdio 桥转接到 `@deepseek-ai/dsh-mcp-client`，不需要额外代码。

- `instance.label` 必填；`placeholder` / `hint` / `help` 可选。`help` 用于在地址弹窗里提供获取地址的官方指引（`{ url, label, hint? }`，url 必须是 https）。
- 带 `instance` 时禁止设置 `server.url`；完整地址由用户填写。
- 用户填写的地址在运行时校验：允许 http/https 与内网，允许 query（用于 `?key=...` 这类地址），拒绝账号密码与锚点；界面会对 http 显示明文提示。
- 地址按用户输入原样保存，不再自动追加路径；provider 的 placeholder / hint 要写清完整端点示例。
- `auth` 四类均可：`none` 保存地址后直接连接；`bearer` / `header` 保存地址后弹出独立令牌弹窗；`oauth2` 要求实例支持 DCR，保存地址后发起授权。
- 带 `instance` 的 provider 加号会先写入一条无 URL 的安装记录，再打开独立地址弹窗；详情只显示提示与「配置」按钮。
- 已配置地址后 `instanceReady=true`；「更换地址」会断开旧连接、清除旧凭据并更新 URL，需要重新配置或授权。未配置时关闭弹窗仍保持安装，可再次打开继续填写。

### 预置地址（instance.presets）

如果地址是一组固定端点（企查查按数据域拆了 10 个 MCP 服务），用 `presets` 把弹窗从手填改成下拉选择：

```json
{
  "instance": {
    "label": "数据域",
    "noun": "数据域",
    "presets": [
      { "label": "工商信息", "url": "https://example.com/mcp/company/stream" },
      { "label": "风险信息", "url": "https://example.com/mcp/risk/stream" }
    ]
  }
}
```

- `presets` 每项必填 `label` / `url`，`url` 必须是 https；数组不能为空。
- 有 `presets` 时用户只能从列表选择，不再手填地址，也不再显示 http 风险提示。
- `noun` 只影响界面措辞：卡片和详情的「更换地址」会变成「更换数据域」，详情提示改成「选择数据域」；不填时仍说「地址」。
- 每个预置仍是一个独立的 MCP 端点，切换后会断开当前连接、清除旧凭据并需要重新连接，界面上要写清这一点。

## Auth 类型

| type | 适用场景 | 关键字段 |
| --- | --- | --- |
| `none` | 公开 MCP，无需凭据 | — |
| `bearer` | `Authorization: Bearer <token>` | `label`，可选 `help` |
| `header` | 自定义请求头，如 `X-API-Key` | `header`、`prefix`（可选）、`label`、`help` |
| `oauth2` | OAuth 2.0 Authorization Code + PKCE | `flow: "pkce"`、`registration`、可选 `scopes` / `clientName` |

OAuth 的 `registration`：

- `"dcr"`：服务端支持动态客户端注册（优先）。
- `{ "clientId": "..." }`：厂商提供公开客户端 ID，且不要求 client secret。

元数据发现由宿主自动完成，provider 只需声明 `registration` 与 `scopes`：

1. 先向 MCP 端点发送一个未授权的 `initialize`，从 401 的 `WWW-Authenticate` 里读取 `resource_metadata` 地址（RFC 9728，优先）；
2. 没有该头时依次尝试 `{origin}/.well-known/oauth-protected-resource{path}` 与 `{resource}/.well-known/oauth-protected-resource` 两种拼法；
3. 从资源元数据的 `authorization_servers[0]` 取 issuer，再读 `{issuer}/.well-known/oauth-authorization-server`；
4. `scopes` 以 provider 声明为准，未声明才用资源元数据的第一个；
5. 授权请求、换 token 和刷新 token 都会带上资源元数据里的 `resource`（RFC 8707）。天眼查会强校验它必须等于 MCP 端点，其他服务忽略即可。

当前不支持 device code、mTLS、多字段凭据；这些场景请先用自定义连接器。只支持 API Key 的服务用 `bearer` / `header`；同时支持 OAuth 与 API Key 的服务，内置卡片走 OAuth，Key 用法交给自定义连接器的 `headers`。

## 凭据帮助链接

token 类 provider 建议提供 `help`：

```json
"help": {
  "url": "https://vendor.example/tokens",
  "label": "创建 API Key",
  "hint": "在 Settings → API 创建；令牌只保存在本机。"
}
```

UI 会在授权表单里展示该链接与提示。链接必须是厂商官方的凭据创建页。

## 示例与文案

- `summary`：卡片上的一句话，≤ 1 行。
- `description`：详情弹窗里的 1–2 句说明。
- `examples`：1–6 条可直接发给 Agent 的提示词；不要写「点这里」这类操作说明。
- `category`：只能是 `开发工具 / 项目管理 / 数据库 / 知识检索 / 办公协作 / 安全运维 / 数据分析 / 其他`。

## 验证清单

- [ ] `npm run check` 通过
- [ ] 目录里有 `provider.json`，`id` 与目录名一致
- [ ] 地址是厂商官方 `https://` MCP 端点，且已在浏览器/文档中确认
- [ ] 使用真实凭据安装、连接成功，记录工具数量
- [ ] 凭据只保存在宿主侧，`provider.json` 中没有密钥
- [ ] 示例提示词可执行，不包含内部项目名或个人信息
- [ ] 图标（如有）为品牌官方素材，无外部脚本/引用
- [ ] PR 描述包含厂商 MCP 文档链接与实测工具数

## 发布与兼容

- `schemaVersion` 当前固定为 `1`；新增能力会通过向后兼容的可选字段扩展。
- 删除或重命名 provider id 会被视为破坏性变更，需要单独讨论。
- 校验与目录加载逻辑在 `src/host/providers.ts`，契约在 `schema/provider.schema.json`。
