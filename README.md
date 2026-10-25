# GitHub 令牌保险箱（gh-vault）

在本机加密保存一枚 GitHub 令牌，让 Agent 代你发 GitHub API 请求，而令牌不会出现在对话或工具返回值里。

同一个仓库放两个宿主版本，共享同一套设计：令牌只落本机、默认只给掩码、明文读取要二次确认。

| 宿主 | 入口 | 工具名前缀 | 加密方式 |
| --- | --- | --- | --- |
| Cyrene（Electron 桌面端） | 根目录 `manifest.json` / `index.cjs` / `panel.html` | `gh-vault_*` | Electron `safeStorage`（Windows 走 DPAPI） |
| DeepSeek Harness（DSH） | `dsh/` 子目录 | `gh_vault_*` | AES-256-GCM + 独立 `key.bin` |

## 下载安装

到 [Releases](https://github.com/bestlike093/gh-vault/releases/latest) 下载对应安装包。

| 宿主 | 安装包 | 大小 | SHA-256 |
| --- | --- | --- | --- |
| Cyrene | `gh-vault-1.1.0.zip` | 8.0 KB | `58d7201f54e2da1e87285103dd2e2386ecb62a99cb69a66807d82316d8074532` |
| DSH | `dsh-gh-vault-1.1.0.zip` | 7.6 KB | `9fe85ce535eb3ef1b81cc129b85b0631d973a4a219299845756465243db24560` |

### Cyrene

在 Cyrene 的「设置 → 插件 → 从文件安装」里选中 `gh-vault-1.1.0.zip`，启用「GitHub 令牌保险箱」，点击插件面板：

1. 粘贴一枚 GitHub Personal Access Token（`ghp_` 或 `github_pat_` 开头），可以写一个备注，点保存；
2. 点「测试连接」确认令牌有效，面板会显示登录名与权限范围；
3. 之后直接说「看看我的 GitHub 用户名」「给这个仓库开个 PR」即可。

### DSH

解压 `dsh-gh-vault-1.1.0.zip` 得到 `dsh-gh-vault/`，放到本机任意位置，然后：

```json
{
  "dependencies": {
    "dsh-gh-vault": "link:D:/plugins/dsh-gh-vault"
  }
}
```

写进 profile 的 `package.json`，在该 profile 目录执行 `pnpm install`，重启 DeepSeek Harness。

> 不要把 `dsh-gh-vault` 同时写进 `dsh.profile.bundles` 和 profile 的 `cordis.patch.yml`——带 `dsh.bundle.patch` 的包会被 loader 自动应用一次，重复注册会让同一组工具出现两份。

完整的 DSH 安装、配置与工具说明见 [dsh/README.md](dsh/README.md)。

## 工具

两边名字只差连字符与下划线，参数一致。

| Cyrene | DSH | 作用 | 关键参数 |
| --- | --- | --- | --- |
| `gh-vault_status` | `gh_vault_status` | 查看是否已保存、掩码、备注、保存时间 | 无 |
| — | `gh_vault_save` | 加密保存令牌（Cyrene 侧走面板保存） | `token` / `tokenFile` / `GH_VAULT_TOKEN`、`label`、`validate` |
| `gh-vault_api` | `gh_vault_api` | 代发 GitHub REST API 请求 | `path`（必填）、`method`、`body` |
| `gh-vault_reveal` | `gh_vault_reveal` | 取出令牌明文 | `confirm="REVEAL"` |
| `gh-vault_clear` | `gh_vault_clear` | 删除令牌与密钥 | `confirm="DELETE"` |

## 网络与存储

- 只访问 `https://api.github.com`
- 不读取 `~/.gitconfig`、`~/.config/gh` 或其他凭据
- 不把令牌写入日志、不放进工具返回值（除 `*_reveal`）

存储位置随宿主不同：Cyrene 存在插件自己的 storage（`%APPDATA%/Cyrene/plugin-data/gh-vault/`），DSH 存在 `$DSH_HOME/plugin-data/dsh-gh-vault/`。

## 安全说明

- 加密密钥与密文保存在同一处，能读这个目录的本机进程仍可解密；它的作用是避免令牌以明文落盘、被误同步进仓库
- 明文会进入本轮对话上下文，`*_reveal` 请只在核对时使用
- 建议使用细粒度 PAT，只授予真正需要的仓库与权限

## 版本记录

- **1.1.0**（2026-10-25）：把 DSH 版并入本仓库的 `dsh/` 子目录，两侧版本号统一；Cyrene 侧代码与此前 1.0.0 完全一致，仅版本号与文档更新
- **1.0.0**（2026-10-25）：首个版本，Cyrene 插件

## 许可

MIT
