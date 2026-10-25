import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

export const name = 'dsh-gh-vault'
export const inject = ['tools']

/**
 * 只依赖 Node 内置模块与 ctx 注入的服务：插件被 link 到任意 profile 时，
 * 裸导入 @deepseek-ai/* 会按插件自身路径解析，宿主包并不在查找链上。
 */

const API_ROOT = 'https://api.github.com'
const TOKEN_RE = /^(ghp_|gho_|ghu_|ghs_|github_pat_)[A-Za-z0-9_]{10,}$/
const TOKEN_ENV = 'GH_VAULT_TOKEN'

function resolveDir(config) {
  if (config && typeof config.dataDir === 'string' && config.dataDir.trim()) {
    return config.dataDir.trim()
  }
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'plugin-data', 'dsh-gh-vault')
}

function renderText(_args, value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return [{ type: 'text', text }]
}

/** 构造工具定义：parameters 直接给注册表可用的 JSON Schema。 */
function tool(name, description, properties, required, execute) {
  const parameters = { type: 'object', properties: properties || {} }
  if (required && required.length > 0) parameters.required = required
  return {
    name,
    description,
    parameters,
    output: { schema: {}, render: renderText },
    execute,
  }
}

function mask(token) {
  if (!token) return ''
  if (token.length <= 8) return '****'
  return token.slice(0, 4) + '…' + token.slice(-4)
}

function messageOf(error) {
  return String(error && error.message ? error.message : error)
}

function normalizeApiPath(raw) {
  const value = String(raw || '').trim()
  if (!value) throw new Error('path 不能为空')
  if (value.includes('://')) throw new Error('path 只接受 GitHub REST API 路径，不能是完整网址')
  if (/\s/.test(value)) throw new Error('path 里不能有空白字符')
  const withSlash = value.startsWith('/') ? value : '/' + value
  if (withSlash.startsWith('//')) throw new Error('path 不能以 // 开头')
  return withSlash
}

async function loadKey(dir, create) {
  const file = path.join(dir, 'key.bin')
  try {
    const key = await fs.readFile(file)
    if (key.length === 32) return key
  } catch (error) {
    if (error && error.code !== 'ENOENT') throw error
  }
  if (!create) return null
  await fs.mkdir(dir, { recursive: true })
  const key = crypto.randomBytes(32)
  await fs.writeFile(file, key, { mode: 0o600 })
  return key
}

async function encryptToken(dir, token, label) {
  const key = await loadKey(dir, true)
  if (!key) throw new Error('无法创建加密密钥')
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()])
  const record = {
    v: 1,
    algorithm: 'AES-256-GCM',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: ciphertext.toString('base64'),
    label: String(label || ''),
    savedAt: new Date().toISOString(),
  }
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'token.json'), JSON.stringify(record, null, 2), { mode: 0o600 })
  return record
}

async function readRecord(dir) {
  try {
    const raw = await fs.readFile(path.join(dir, 'token.json'), 'utf8')
    return JSON.parse(raw)
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw error
  }
}

async function decryptToken(dir, record) {
  if (!record || !record.data) return null
  const key = await loadKey(dir, false)
  if (!key) return null
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(record.iv, 'base64'))
    decipher.setAuthTag(Buffer.from(record.tag, 'base64'))
    const plain = Buffer.concat([
      decipher.update(Buffer.from(record.data, 'base64')),
      decipher.final(),
    ])
    return plain.toString('utf8')
  } catch {
    return null
  }
}

/**
 * 令牌来源优先级：参数 token > tokenFile 文件首行 > GH_VAULT_TOKEN 环境变量。
 * 后两种方式可以让明文不进入对话与工具调用记录。
 */
async function resolveTokenInput(args) {
  const direct = String(args.token || '').trim()
  if (direct) return { token: direct, source: 'argument' }

  const file = String(args.tokenFile || '').trim()
  if (file) {
    let raw
    try {
      raw = await fs.readFile(file, 'utf8')
    } catch (error) {
      throw new Error('读取 tokenFile 失败：' + messageOf(error))
    }
    const token = raw.split(/\r?\n/)[0].trim()
    if (!token) throw new Error('tokenFile 里没有读取到内容')
    return { token, source: 'file' }
  }

  const env = String(process.env[TOKEN_ENV] || '').trim()
  if (env) return { token: env, source: 'environment' }

  return { token: '', source: '' }
}

function githubHeaders(token) {
  return {
    Authorization: 'Bearer ' + token,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'dsh-gh-vault',
  }
}

async function githubRequest(token, method, apiPath, body, signal) {
  const headers = githubHeaders(token)
  let payload
  if (body !== undefined && body !== null && method !== 'GET' && method !== 'HEAD') {
    headers['Content-Type'] = 'application/json'
    payload = JSON.stringify(body)
  }
  const response = await fetch(API_ROOT + apiPath, { method, headers, body: payload, signal })
  const text = await response.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    data = text
  }
  return { ok: response.ok, status: response.status, data }
}

export function apply(ctx, config = {}) {
  const dir = resolveDir(config)

  ctx.tools.register(
    tool(
      'gh_vault_status',
      '查看本机保存的 GitHub 令牌状态：是否已保存、掩码、备注、保存时间与加密方式。不会返回明文。用户问「令牌保存了吗 / 我的 GitHub 令牌是什么状态」时使用。',
      {},
      [],
      async () => {
        try {
          const record = await readRecord(dir)
          if (!record) {
            return { ok: true, saved: false, message: '还没有保存 GitHub 令牌', dataDir: dir }
          }
          const token = await decryptToken(dir, record)
          return {
            ok: true,
            saved: true,
            masked: token ? mask(token) : '（无法解密，可能换了机器或密钥被删除）',
            label: record.label || '',
            savedAt: record.savedAt || '',
            algorithm: record.algorithm || 'AES-256-GCM',
            dataDir: dir,
          }
        } catch (error) {
          return { ok: false, error: messageOf(error) }
        }
      },
    ),
  )

  ctx.tools.register(
    tool(
      'gh_vault_save',
      '在本机加密保存一个 GitHub 令牌，供 gh_vault_api 代发请求。用户说「保存这个 GitHub 令牌」时使用。令牌可来自参数、本地文件首行（tokenFile）或环境变量 GH_VAULT_TOKEN；用后两者可避免明文进入对话。返回结果不会回显明文。',
      {
        token: {
          type: 'string',
          description: 'GitHub 令牌，通常以 ghp_ 或 github_pat_ 开头；与 tokenFile 二选一',
        },
        tokenFile: {
          type: 'string',
          description: '本地文件路径，读取第一行作为令牌；适合不想把令牌写进对话时使用',
        },
        label: {
          type: 'string',
          description: '可选备注，例如「工作机 PAT」',
        },
        validate: {
          type: 'boolean',
          description: '是否先调用 /user 验证令牌有效，默认 true',
        },
      },
      [],
      async (args, exec) => {
        try {
          const input = await resolveTokenInput(args)
          if (!input.token) {
            return {
              ok: false,
              error: '没有拿到令牌：请提供 token、tokenFile，或设置环境变量 ' + TOKEN_ENV,
            }
          }
          if (!TOKEN_RE.test(input.token)) {
            return { ok: false, error: '令牌格式不像 GitHub Token（应以 ghp_ / github_pat_ 等开头）' }
          }

          const label = String(args.label || '').trim()
          const shouldValidate = args.validate !== false
          if (!shouldValidate) {
            const record = await encryptToken(dir, input.token, label)
            return {
              ok: true,
              saved: true,
              source: input.source,
              masked: mask(input.token),
              label: record.label,
              savedAt: record.savedAt,
              dataDir: dir,
            }
          }

          const check = await githubRequest(input.token, 'GET', '/user', undefined, exec && exec.signal)
          if (!check.ok) {
            return { ok: false, error: '令牌验证失败（HTTP ' + check.status + '），没有保存' }
          }
          const record = await encryptToken(dir, input.token, label)
          return {
            ok: true,
            saved: true,
            source: input.source,
            login: check.data && check.data.login ? check.data.login : '',
            masked: mask(input.token),
            label: record.label,
            savedAt: record.savedAt,
            dataDir: dir,
          }
        } catch (error) {
          return { ok: false, error: messageOf(error) }
        }
      },
    ),
  )

  ctx.tools.register(
    tool(
      'gh_vault_api',
      '用本机保存的 GitHub 令牌请求 api.github.com，令牌不会出现在结果里。需要查仓库、建分支、提 PR、查用户信息时优先用这个工具。path 传 API 路径，例如 /user 或 /repos/owner/repo。',
      {
        path: {
          type: 'string',
          description: 'GitHub REST API 路径，例如 /user、/repos/owner/repo',
        },
        method: {
          type: 'string',
          description: 'HTTP 方法：GET / POST / PATCH / PUT / DELETE，默认 GET',
        },
        body: {
          type: 'object',
          description: '请求体对象，GET/HEAD 时忽略',
        },
      },
      ['path'],
      async (args, exec) => {
        let apiPath
        try {
          apiPath = normalizeApiPath(args.path)
        } catch (error) {
          return { ok: false, error: messageOf(error) }
        }
        const method = String(args.method || 'GET').toUpperCase()
        if (!['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'HEAD'].includes(method)) {
          return { ok: false, error: '不支持的 HTTP 方法：' + method }
        }
        try {
          const record = await readRecord(dir)
          const token = await decryptToken(dir, record)
          if (!token) return { ok: false, error: '还没有保存 GitHub 令牌，请先调用 gh_vault_save' }
          const result = await githubRequest(token, method, apiPath, args.body, exec && exec.signal)
          return { ok: result.ok, status: result.status, path: apiPath, method, data: result.data }
        } catch (error) {
          return { ok: false, error: messageOf(error) }
        }
      },
    ),
  )

  ctx.tools.register(
    tool(
      'gh_vault_reveal',
      '返回本机保存的 GitHub 令牌明文。只在用户明确要求「把令牌显示出来 / 我要核对令牌」时调用；明文会进入本轮对话记录，无法撤回。日常操作请改用 gh_vault_api。',
      {
        confirm: {
          type: 'string',
          description: '二次确认，必须传 REVEAL',
        },
      },
      ['confirm'],
      async (args) => {
        if (String(args.confirm || '') !== 'REVEAL') {
          return { ok: false, error: '需要 confirm="REVEAL" 才会返回明文' }
        }
        try {
          const record = await readRecord(dir)
          const token = await decryptToken(dir, record)
          if (!token) return { ok: false, error: '没有可用令牌（未保存或无法解密）' }
          return { ok: true, token, label: record.label || '', savedAt: record.savedAt || '' }
        } catch (error) {
          return { ok: false, error: messageOf(error) }
        }
      },
    ),
  )

  ctx.tools.register(
    tool(
      'gh_vault_clear',
      '删除本机保存的 GitHub 令牌（同时清理加密密钥）。用户要求撤销或更换令牌时使用。',
      {
        confirm: {
          type: 'string',
          description: '二次确认，必须传 DELETE',
        },
      },
      ['confirm'],
      async (args) => {
        if (String(args.confirm || '') !== 'DELETE') {
          return { ok: false, error: '需要 confirm="DELETE" 才会删除' }
        }
        try {
          await fs.rm(path.join(dir, 'token.json'), { force: true })
          await fs.rm(path.join(dir, 'key.bin'), { force: true })
          return { ok: true, removed: true, message: '本机令牌与加密密钥已删除' }
        } catch (error) {
          return { ok: false, error: messageOf(error) }
        }
      },
    ),
  )
}
