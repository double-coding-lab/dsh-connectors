# dsh-connectors

DeepSeek Harness 的 MCP 连接器插件。提供独立的侧栏面板：浏览连接器目录，一键接入 MCP Server 并完成授权与凭据保管；支持 mcpServers JSON 自定义接入、连接状态与故障诊断。MCP 连接、stdio 子进程与工具注册由 DSH 官方 `@deepseek-ai/dsh-mcp-client` 负责，插件只做目录、凭据和界面。

## 当前进度

已完成：

- 插件骨架、侧栏面板、内置目录（GitHub / Linear / Neon / Supabase / GitLab.com / GitLab 自建 / Context7）、搜索与分类。
- Provider 数据化：新增 provider 只需 `providers/<id>/provider.json`（可选 `icon.svg`），OAuth 也由数据描述驱动，无厂商分支；契约与贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。
- 内置连接器安装/删除、凭据本机存储、重启后恢复、工具数量展示。
- 内置 token 型 provider：Linear（API Key，项目管理）、Neon / Supabase（API Key / PAT，数据库）；安装只写记录，随后在授权表单输入 token；关闭表单后卡片保留「授权」+ 已安装对勾。令牌输入框默认隐藏内容，右侧眼睛按钮可切换明文/密文，切换不改变已输入内容。
- 已授权后可直接更新凭据，不必删除重装：token 卡片在「更多」菜单或详情底部提供「更新令牌」，卡片入口弹出独立的更新弹窗，详情入口在其上叠加二级弹窗；空白输入、旧令牌不回显，保存后原地替换。OAuth 卡片提供「重新授权」，点击后卡片状态立即从对勾切换为 loading，取消或失败保留旧授权。二级弹窗出现时一级弹窗的蒙版让位给二级，只保留最上层一层遮罩，避免背景越叠越暗。
- 自定义 `mcpServers` JSON 导入：Streamable HTTP（`url` / `headers`）与 stdio（`command` / `args` / `env` / `cwd`）。
- 自定义连接器与内置目录混排，标「自定义」，支持删除。
- 私网 / localhost 地址二确认；`serverName` 冲突拒绝；凭据只存宿主侧、API 不回传。
- 点击卡片只打开详情弹窗（描述、状态、工具、示例）；安装由卡片右侧加号直接触发，或详情里的「安装」按钮。
- 加号仅悬停卡片时显示；点击即安装，不再先打开详情或安装步骤；OAuth 卡片安装后自动用默认浏览器发起授权，无凭据卡片直接连接；需要令牌的卡片（如 GitHub PAT）点加号先持久化安装记录，再弹出授权表单输入 token。
- 已连接显示绿色对勾，失败显示红色警示；状态图标无边框、无底色，只有一个图标；已安装未授权时显示「授权」按钮、一个已安装对勾圆钮，加号不再出现。
- 卡片「授权」直接发起授权，不打开详情；失败在卡片内展示，只有默认浏览器未能打开时才降级打开详情给手动链接。
- 侧栏「连接器」入口图标使用插头，和「插件」的 pinwheel 区分。
- 悬停后状态图标保留并以 260ms 缓动左移让位，右侧渐显「更多 + 启用开关」，整组始终右对齐；控制区在卡片内裁剪，动画过程不会溢出卡片。
- 卡片描述最多两行，超出显示省略号；仅当文本被截断时，悬停才在下方显示深色 tooltip 展示全文。
- 「更多」菜单包含去试试、更新令牌（token）、重新授权 / 取消授权（OAuth）、断开（自定义）、删除（内置与自定义统一为「删除」）。去试试按示例顺序轮询：第一次第一条、第二次第二条，序号存 localStorage，跨会话/刷新保留。去试试按示例顺序轮询：第一次第一条、第二次第二条，序号存 localStorage，跨会话/刷新保留。
- 加号是 28px 白色圆形按钮（0.5px 描边 + 轻阴影），卡片悬停时出现；鼠标移到加号上背景加深、阴影增强；安装中显示旋转 loading，鼠标移开也保持可见。
- 连接/启用失败只在卡片内显示错误文案（最多两行，悬停看全文），不再出现页面级错误条；卡片开关在启用/停用处理中显示 spinner。
- 输入框左侧以紧凑图标组显示已启用连接器：多图标时品牌图标与圆形背景同直径 18×18，无额外白圈/描边；左侧图标在上层、右侧图标在后，相邻重叠 7px（约 39%），最多 3 个，超过显示 `+N`；`+N` 为 18×18 独立占位、与最后一个图标留 2px，不覆盖图标；单图标为 24×24（32×32 命中区），多图标为 28 高胶囊，宽度由内容撑开。
- 静止只有图标，悬停出现浅灰底，背景宽度随图标数量动态变化，图标不位移；整组点击打开连接器浮层。
- 浮层只负责启用/停用：已连接的显示开关；未安装显示「去连接」、已安装未授权显示「去授权」，点击统一打开侧栏连接器面板完成安装与授权，不再内联输入令牌；多字段凭据显示「未接入」。
- 详情弹窗展示每个工具的名称与描述；默认预览 4 个，工具列表固定 240px 高并在内部滚动，不强行撑高弹窗。
- 详情弹窗的状态 pill 放在标题右上角（关闭按钮左侧）；已连接只显示「已连接」，工具数量交给下方「可用工具」列表；内置连接器的「删除」使用危险色。
- 工具描述默认两行，行右侧箭头图标展开/收起完整描述；展开后仍在列表内滚动。
- 「去试试」新建会话并预填示例，不自动发送；通过 `clearPreviousDraft` 替换旧草稿。复制与去试试使用同一份提示词：示例未包含连接器名时自动加「使用 <名称>：」前缀。未连接 / 停用 / 无工具时，示例里的去试试与菜单一起置灰。
- 「试试这样用」每行右侧是两个图标按钮（复制 / 去试试），不显示文字，悬停显示深色 tooltip；整行不可点击。

- GitLab.com 使用官方 MCP（`https://gitlab.com/api/v4/mcp`）。安装只写入连接记录、不建 loader 条目；授权时由宿主打开系统默认浏览器，走动态客户端注册 + PKCE S256，授权回调在宿主侧完成；access token、refresh token 与客户端信息只存本机，并在过期前自动刷新。自建实例见「GitLab 自建」。

未完成：内网 GitLab 接入、多字段凭据 UI、远程目录；GitHub OAuth / device flow 作为后续可选。

已验证：

- Context7：连接后注册 `mcp__context7__query-docs`、`mcp__context7__resolve-library-id`，重启 host 后自动恢复。
- 自定义 HTTP：导入后连接，工具注册成功；删除已连接连接器会注销工具并删除记录。
- 自定义 stdio：`npx -y @modelcontextprotocol/server-everything` 连接后注册 22 个工具，重启 host 后恢复。
- 冲突、私网确认、非法 JSON、删除与面板导入/删除流程均验证通过。
- 卡片详情与示例：示例行右侧为两个 28px 图标按钮，无文字；悬停 tooltip 分别为「复制」「去试试」。停用 Context7 时 pill「已停用」、去试试 `disabled` 且 opacity 0.4、复制仍可用；恢复后去试试恢复。复制内容与去试试一致：第二条示例的剪贴板 payload 为「使用 Context7：查 Next.js 15 …」。复制失败时图标变警示红并显示「复制失败」（自动化浏览器权限受限）。
- 卡片/加号：点卡片只打开详情；GitLab 点加号直接安装并自动发起授权，全程不出现详情/安装步骤弹窗，卡片从加号切到「取消授权」，取消后回到「授权」；详情里的「安装」仍保留安装后授权的弹窗路径。
- 加号反馈：卡片悬停出现 28px 白色圆按钮（0.5px 描边、轻阴影）；悬停加号时背景变为浅灰、阴影增强；安装中按钮禁用并显示 14px 旋转 spinner（aria「正在安装」），鼠标移出卡片后 opacity 仍为 1。
- 安装/授权拆分：OAuth 卡片调用 `POST /api/connections` 只落安装记录（`authorized=false`、无 loader 条目、无错误），重复安装保留 `createdAt`；重启 host 后未授权记录保持安装状态且不触发工具探测。
- 授权中/取消：卡片「授权」直接打开默认浏览器，不打开详情；卡片按钮切为「取消授权」，详情安装路径的弹窗内也可取消。取消后回到「未授权」，记录保留、无错误，`/api/oauth/cancel` 生效。
- 工具详情：Context7 显示 2 个工具及描述；everything stdio 显示 22 个工具，默认 4 个，展开后列表固定 240px、内部滚动（scrollHeight 1418）。
- 卡片描述：两行 clamp；GitHub / Context7 的 `scrollHeight === clientHeight === 36` 时不弹 tooltip，GitLab 的 `scrollHeight 54 > clientHeight 36` 时悬停显示完整文本，`pointerout` 关闭。
- 启用 / 停用：切换后 loader 条目移除 / 重建，工具数归零 / 恢复；停用状态卡片显示灰色对勾与关闭开关。
- 更多菜单「去试试」：第一次预填第一条示例、第二次第二条；序号写入 `dsh-connectors:trial-index:<connectorId>`（实测 1 → 2），清空后从第一条重新开始；`clearPreviousDraft` 会替换旧草稿。
- 输入框图标条：Context7 连接后出现图标；接入 4 个连接器时显示 3 个图标 + `+1`，点击打开浮层。
- 输入框浮层：搜索 `git` 只保留 GitHub / GitLab；已连接显示开关；GitLab 未安装显示「去连接」、未授权显示「去授权」，点击打开侧栏面板；「管理连接器」同样打开面板。
- 去试试提示词：无示例的自定义连接器 `dock-a` 预填为「使用 dock-a 的工具完成一个简单任务，先列出可用工具。」
- 样式核对：卡片标题 14/500/20、描述 13/18 tertiary、标签 10/18；弹窗 560 宽/28 圆角/gap 20，标题 16/500/24，输入与按钮 40 高。
- 详情头部：未连接 pill 位于 header 内、右边缘距关闭按钮 12px；Context7 已连接时 pill 仅「已连接」，下方工具区显示「可用工具 2」；内置连接器「删除」按钮计算色为 `rgb(236,19,19)`。
- 侧栏图标：连接器入口改为插头 SVG（3 条 path：两脚、插头体、线缆），与「插件」pinwheel 区分。
- GitHub PAT：卡片目录为 `auth.type=bearer`；加号/详情安装只写记录并弹出 token 授权表单；空 token 时「连接」禁用。填入假 token 后连接超时并显示凭据错误，未落记录；真实 PAT 已连接并注册 46 个工具。已连接失败时的「重新连接」+ 空白 token 输入为同一套 `tokenEntry` 分支。
- 安装/授权分离（token）：Linear 详情「安装」后卡片变为「未授权」+「授权」+已安装对勾，弹窗显示 `Linear API Key` 表单；关闭并刷新后仍是「授权/未授权」，不再显示「安装」。Neon 加号同样直接安装并弹出授权表单；测试记录已删除。
- 目录：7 张内置卡（GitHub / Linear / Neon / Supabase / GitLab.com / GitLab 自建 / Context7），分类新增「项目管理」「数据库」；Linear 安装步骤显示 `Linear API Key`、创建链接与权限提示，Neon / Supabase 复用同一结构。provider 改为按目录组织，OAuth 走通用元数据 + DCR/静态 clientId。
- GitLab.com OAuth：真实授权已完成，GitLab MCP 注册 36 个工具；`POST /api/oauth/start` 完成元数据发现、动态客户端注册并通过系统默认浏览器打开（`opened=true`）；取消授权后流程回到未授权。回调非法 state、provider 错误、非法 redirectUri 均返回 400 与错误页。

## 结构

```
src/
  index.ts             宿主入口：注入服务、恢复连接、注册 web 路由
  host/catalog.ts      读取 providers 目录并组装内置目录
  host/providers.ts    provider.json 契约校验、目录扫描与卡片映射
  host/errors.ts       ConnectError
  host/mcpServers.ts   mcpServers JSON 解析、校验与私网识别
  host/oauth.ts        OAuth 元数据发现、DCR、PKCE、code 交换与刷新
  host/openExternal.ts 用系统默认浏览器打开授权页
  host/connections.ts  loader 条目供给、连接生命周期、安装/授权编排、自定义连接器、工具计数
  host/store.ts        storage domain：连接记录与自定义连接器
  host/routes.ts       /dsh-connectors/api/*
  client/index.tsx     侧栏面板、卡片详情弹窗、导入/删除对话框（slots 注册）
  client/icons.tsx     DSH 原生图标
  client/provider-icons.generated.ts  构建生成的 provider 图标 data URL
  shared/types.ts      卡片、连接与接口类型
providers/<id>/provider.json  内置连接器（唯一信源）
providers/<id>/icon.svg       可选品牌图标（png / webp 也可）
schema/provider.schema.json   provider 契约（JSON Schema）
scripts/build-provider-icons.mjs  生成客户端图标映射
scripts/check-providers.mjs       校验 provider 目录
scripts/new-provider.mjs          生成新 provider 骨架
```

## 新增 Provider

```bash
npm run provider:new -- acme --auth bearer --name "Acme"
# 编辑 providers/acme/provider.json，放入可选 icon.svg
npm run check        # typecheck + build + provider/instance 校验与测试
```

契约、auth 类型、OAuth 注册方式和 PR 检查清单见 [CONTRIBUTING.md](CONTRIBUTING.md)。内置 provider 只接受数据描述与静态图标，不允许携带可执行代码；本地 stdio / 内网地址继续走「自定义连接器」。

## 自定义连接器

面板右上角「自定义连接器」接受标准 `mcpServers` JSON：

```json
{
  "mcpServers": {
    "my-http-server": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer <token>" },
      "x-dsh": {
        "description": "查询最新接口文档与示例",
        "category": "知识检索",
        "examples": ["用 my-http-server 查一下最新的接口文档"]
      }
    },
    "my-stdio-server": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-everything"],
      "env": { "API_KEY": "<token>" }
    }
  }
}
```

规则：

- 导入弹窗提供「描述」「类别」「示例提示词（每行一条）」；单个 Server 的 `x-dsh` 会以占位提示展示，表单留空时使用 `x-dsh`，填写则覆盖。多 Server 时填写表单会覆盖所有 Server 的 `x-dsh`，留空则各 Server 使用自己的值。描述与示例均可留空。
- 类别可输入新名称，内置类别与同名自定义类别会合并；`全部`、`自定义` 为保留名，来源仍用「自定义」badge 表示。
- 主按钮「导入并连接」只对单个 server 自动安装并连接；多个 server 时请用「仅导入」，导入后分别连接。
- 自定义卡片在未安装态可从「更多」直接删除；已连接时「更多」提供「断开」与「删除」：断开只移除连接和工具、保留连接器定义，删除会一并清理连接记录、loader 条目和连接器定义。详情弹窗内同样保留这两个入口。
- 没有示例的卡片不再显示负向提示，「试试这样用」整节直接隐藏。
- `serverName` 只允许 1–32 位字母、数字、下划线或短横线，且不能与内置或已有自定义连接冲突。
- `url` 与 `command` 二选一；`headers` / `env` 的值只保存在宿主侧 storage domain，目录与连接接口不回传。
- `localhost`、内网 IP、`.local` / `.internal` 地址首次提交返回 `private_url_confirmation`，面板勾选确认后重试。
- stdio 会在本机启动命令，只应导入可信配置；连接后工具以 `mcp__<serverName>__*` 注册。
- 工具探测：HTTP 与 stdio 均最多等待 30 秒；GitLab.com 的 initialize + tools/list 实测可达 15 秒，超时按连接失败处理并删除 loader 条目。启用失败时错误写入连接记录，卡片内展示，页面顶部不再出现错误条。

## GitLab.com OAuth

- 卡片 `auth.type: oauth2`（`registration: dcr`）。安装与授权分离：`POST /api/connections` 只写入安装记录（`authorized=false`），不创建 loader 条目，也不探测工具。
- 入口：卡片加号点击即安装并自动发起授权；详情「安装」走同样的安装后授权流程，但保留弹窗展示进度。已安装未授权时，卡片和详情显示「授权」，点击可再次发起。
- 点授权后宿主读取 protected-resource / authorization-server 元数据、动态注册客户端并生成 PKCE S256 授权 URL，再调用系统默认浏览器打开（Windows `rundll32`、macOS `open`、Linux `xdg-open`）；已在运行的浏览器会新开一个标签页。
- 面板每 1.2 秒轮询 `/api/oauth/status`；授权中卡片按钮变为「取消授权」，弹窗内同样可取消；宿主删除 pending state 并停止流程，记录保持安装但未授权。浏览器未自动打开时，弹窗展示手动授权链接。客户端等待 90 秒无回调会自动取消流程并回到未授权。
- 回调只接受本机地址（`127.0.0.1` / `localhost` / `[::1]`），state 10 分钟有效且一次性使用；token 交换成功后更新安装记录、创建 loader 条目并探测工具。
- 记录只保留 `accessToken`、`refreshToken`、过期时间与客户端注册信息；视图、日志与错误文案都不回传 token。
- 重启、重新启用时若 token 将在 60 秒内过期，会先用 refresh token 刷新并写回记录；未授权安装记录不参与 restore；刷新失败记录 `lastError`，需重新授权。
- 回调已拿到 token 但工具注册失败时，连接保留为停用记录并写入错误；直接「启用」重试即可，不需要重新授权。
- 「取消授权」清空 token、移除 loader 条目但保留安装记录，卡片回到「授权」；「删除」才是卸载并删除记录。GitLab 侧的客户端授权可在 GitLab 账号的 Applications 中撤销。

## GitLab 自建

- 卡片 `instance` + `auth.type: oauth2`（`registration: dcr`）。点加号或详情「安装」会先写入一条 `authorized=false` 的安装记录（此时 `url` 为空、`instanceReady=false`），再打开授权弹窗填写实例地址。
- 地址支持 `https`、`http` 与内网 IP；http 会在表单里提示明文传输风险。地址为空时「配置并授权」禁用。
- 地址解析规则：必须显式带 `http://` 或 `https://`；禁止 URL 内嵌账号密码、query、hash；允许带子路径；末尾 `/` 自动去掉；若粘贴了完整的 `/api/v4/mcp` 也会规范化为实例基地址。
- 提交地址后 `POST /api/connections {connectorId, instanceUrl}` 补写记录 URL，`instanceReady=true`，随后自动发起 OAuth。授权、刷新与重启都使用记录里的地址。
- 关闭授权弹窗或取消授权后，记录保持安装：已配置地址时直接显示「授权」；未配置时再次打开弹窗继续填地址。换实例在已配置后需删除重装。
- 实例必须支持 MCP 端点与 OAuth 动态客户端注册（DCR）；缺少 DCR 会明确报错，不回退 PAT。旧实例或不支持 DCR 的场景使用自定义连接器。

## GitHub PAT

- 卡片 `auth.type: bearer`，通过 `Authorization: Bearer <PAT>` 连接 `https://api.githubcopilot.com/mcp/`；不注册 OAuth App，不需要 client_id / secret / 后端。
- 点加号或详情「安装」只写安装记录（无 auth、不建 loader），随后弹出授权表单：`GitHub PAT` 输入框 +「创建 GitHub PAT」链接（预填 `repo,read:org,read:user`）+ 权限提示；token 只存宿主侧。
- 关闭授权表单后卡片保留「授权」按钮和已安装对勾；重新打开面板仍是「未授权」，不会回到「安装」。点「授权」重新打开 token 表单。
- 首次连接失败不落记录；已有连接失败时，详情弹窗显示「重新连接」和空白 token 输入框，可粘贴新 token 重试，避免只能删除重装。
- PAT 的仓库范围、组织权限与过期时间由用户管理；建议按最小权限创建并在过期前更新。

## 开发

```bash
npm install
npm run check        # typecheck + build
```

开发期建议用 web profile 迭代：client 改动构建后刷新页面即可；host 改动才需要重启 `dsh web`。桌面端使用 `desktop` profile，需要完全退出后重启。

## 接口

- `GET /dsh-connectors/api/health` — 版本与宿主能力（tools / storageDomain / loader / webServer）
- `GET /dsh-connectors/api/catalog` — 内置 + 自定义连接器目录（自定义卡片不含 url / headers / env）
- `GET /dsh-connectors/api/connections` — 已配置连接与实时工具数量
- `POST /dsh-connectors/api/connections` — `{ connectorId, token? }`；令牌 / 无凭据卡片直接连接，OAuth 卡片只安装并返回 `authorized=false` 的连接视图
- `PATCH /dsh-connectors/api/connections/:connectorId` — `{ enabled }`；停用只移除 loader 条目、保留配置与凭据，启用时重建并重新探测工具
- `DELETE /dsh-connectors/api/connections/:connectorId` — 断开并卸载连接，移除 loader 条目与记录
- `POST /dsh-connectors/api/oauth/start` — `{ connectorId, redirectUri }`，要求已安装；返回 `{ authorizeUrl, flowId, opened }`，并打开系统默认浏览器
- `GET /dsh-connectors/api/oauth/status?flowId=` — 返回授权流程状态 `pending / done / error / expired`
- `POST /dsh-connectors/api/oauth/cancel` — `{ flowId }`；取消 pending 授权，记录保持安装
- `GET /dsh-connectors/api/oauth/callback` — GitLab 授权回调；完成 token 交换、建连与工具探测，返回结果页
- `DELETE /dsh-connectors/api/connections/:connectorId/oauth` — 取消授权：清空 token、移除 loader 条目，保留安装记录
- `POST /dsh-connectors/api/custom-connectors` — `{ json, allowPrivate?, description?, category?, examples? }`，导入一个或多个自定义 MCP Server；非空的批量 description/category/examples 覆盖 `x-dsh`，留空则使用 `x-dsh`
- `DELETE /dsh-connectors/api/custom-connectors/:connectorId` — 删除自定义连接器；若已连接会先注销工具并删除连接记录

## 依赖边界

- DSH 必须 `>=0.2.0-rc.2 <0.3.0`
- MCP 连接不自己实现，通过 `ctx.loader` 创建 `@deepseek-ai/dsh-mcp-client` 条目
- 凭据只存在宿主侧 storage domain，接口只返回连接视图，不回传 token
- storage domain `dsh_connectors` v1：`connections` 与 `custom_connectors` 两张表
