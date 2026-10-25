# dsh-gh-vault

把 GitHub 令牌加密放在本机，让 DeepSeek Harness（DSH）的 Agent 代发 GitHub API 请求，令牌不进入对话、不出现在工具结果里。

这是 [gh-vault](https://github.com/bestlike093/gh-vault) 的 DSH 侧实现，源码在仓库的 `dsh/` 子目录。

## 功能

- **本机加密**：令牌用 AES-256-GCM 加密后写入 `$DSH_HOME/plugin-data/dsh-gh-vault/token.json`，密钥单独存在 `key.bin`
- **三种写入来源**：直接传 `token`、从本地文件首行读取（`tokenFile`）、或读环境变量 `GH_VAULT_TOKEN`；后两种不会把明文写进对话
- **一次保存**：默认先调用 `/user` 验证令牌有效，失败不会写入
- **代发请求**：`gh_vault_api` 直接代理 GitHub REST API，模型只看到响应内容
- **最小暴露**：日常只返回掩码（如 `ghp_…a1b2`）；明文需要显式传 `confirm="REVEAL"`，删除需要 `confirm="DELETE"`

## 安装到 dsh profile

到 [Releases](https://github.com/bestlike093/gh-vault/releases/latest) 下载 `dsh-gh-vault-1.1.0.zip`，解压得到 `dsh-gh-vault/` 目录，放到本机任意位置（例：`D:/plugins/dsh-gh-vault`）。

以 `desktop` profile 为例（`~/.dsh/profiles/desktop`）：

1. 在 profile 的 `package.json` 里加一条 link 依赖：

```json
{
  "dependencies": {
    "dsh-gh-vault": "link:D:/plugins/dsh-gh-vault"
  }
}
```

2. 在 profile 目录安装依赖（生成 `node_modules/dsh-gh-vault` 链接）：

```bash
pnpm install
```

3. 重启 DeepSeek Harness。

`desktop` profile 由桌面应用独占管理，命令行 `dsh --profile desktop` 不会启动它；安装完成后以桌面应用重启为准。

> **不要**再把 `dsh-gh-vault` 加进 `dsh.profile.bundles`，也不要在 profile 的 `cordis.patch.yml` 里再写一条 `insert`。带 `dsh.bundle.patch` 的包在安装后会被 loader 自动作为 bundle 层应用一次，重复注册会让同一组工具出现两份。

> `tools` seam 不支持热重载，改完插件源码或首次安装后需要重启。

### 不依赖宿主包

插件只使用 Node 内置模块和 `ctx.tools`，不导入 `@deepseek-ai/*`。这样从任意磁盘位置 `link` 进 profile 都能解析，不会出现 `Cannot find package '@deepseek-ai/schemastery'`。

## 配置

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `dataDir` | string | `$DSH_HOME/plugin-data/dsh-gh-vault` | 自定义数据目录 |

```yaml
- insert:
    - id: dsh-gh-vault
      name: dsh-gh-vault
      config:
        dataDir: D:/dsh-data/gh-vault
```

## 工具

| 工具 | 作用 | 关键参数 |
| --- | --- | --- |
| `gh_vault_status` | 查看是否保存、掩码、备注、保存时间 | 无 |
| `gh_vault_save` | 加密保存令牌 | `token` / `tokenFile` / `GH_VAULT_TOKEN`、`label`、`validate` |
| `gh_vault_api` | 代发 GitHub REST API | `path`（必填）、`method`、`body` |
| `gh_vault_reveal` | 返回令牌明文 | `confirm="REVEAL"` |
| `gh_vault_clear` | 删除令牌与密钥 | `confirm="DELETE"` |

示例：

```text
gh_vault_save(tokenFile="D:/secrets/github-pat.txt", label="工作机 PAT")
gh_vault_api(path="/repos/owner/repo/issues", method="POST", body={ title: "标题" })
```

`path` 可以省略前导 `/`，但不接受完整网址或含空白的值。

## 数据与网络

| 位置 | 内容 |
| --- | --- |
| `token.json` | 令牌密文、IV、认证标签、备注、保存时间 |
| `key.bin` | 32 字节随机密钥，权限 0600 |

- 只访问 `https://api.github.com`
- 不读取 `~/.gitconfig`、`~/.config/gh` 或其他凭据
- 不把令牌写入日志、不放进工具返回值（除 `gh_vault_reveal`）

## 安全说明

- 加密密钥与密文在同一目录，能读这个目录的本机进程仍可解密；它的作用是避免令牌以明文落盘、被误同步到仓库
- 令牌明文会进入本轮对话上下文，`gh_vault_reveal` 请只在核对时使用
- 建议使用细粒度 PAT，只授予需要的仓库与权限

## 本地测试

插件注册后可直接在 dsh 里让 Agent 调用：

```text
gh_vault_status()
```

预期返回 `saved: false`（首次）或掩码与保存时间。再用一个测试令牌执行 `gh_vault_save`、`gh_vault_api(path="/user")`、`gh_vault_clear(confirm="DELETE")`，即可覆盖保存、代发与清理三条路径。

## 许可

MIT
