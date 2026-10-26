# Providers

每个子目录是一个内置连接器，`provider.json` 是唯一信源，`icon.svg|png|webp` 可选。修改后运行：

```bash
npm run providers:icons   # 重新生成 src/client/provider-icons.generated.ts
npm run check             # 类型检查 + 构建 + provider 校验
```

当前内置：

| id | auth | 分类 |
| --- | --- | --- |
| github | bearer | 开发工具 |
| linear | bearer | 项目管理 |
| neon | bearer | 数据库 |
| supabase | bearer | 数据库 |
| gitlab | oauth2 | 开发工具 |
| gitlab-self-hosted | oauth2（instance） | 开发工具 |
| context7 | none | 知识检索 |

新增或修改 provider 的完整规则见 [CONTRIBUTING.md](../CONTRIBUTING.md)。
