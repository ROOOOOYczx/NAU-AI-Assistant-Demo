import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const port = Number(process.env.SHIZHIXUEBAN_PROXY_PORT || 8787)
const academicHomeUrl = 'https://jw.nau.edu.cn/'
const dataDirectory = path.join(process.cwd(), 'data')
const conversationsFile = path.join(dataDirectory, 'conversations.json')

async function ensureConversationStore() {
  await fs.mkdir(dataDirectory, { recursive: true })
  try {
    await fs.access(conversationsFile)
  } catch {
    await fs.writeFile(conversationsFile, '[]\n', 'utf8')
  }
}

async function readConversations() {
  await ensureConversationStore()
  const raw = await fs.readFile(conversationsFile, 'utf8')
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    throw new Error('对话文件格式损坏，请检查 data/conversations.json')
  }
}

async function writeConversations(items) {
  await ensureConversationStore()
  const temporaryFile = `${conversationsFile}.tmp`
  await fs.writeFile(temporaryFile, `${JSON.stringify(items, null, 2)}\n`, 'utf8')
  await fs.rename(temporaryFile, conversationsFile)
}

function normalizeConversation(input) {
  const type = input?.type === 'case' ? 'case' : input?.type === 'qa' ? 'qa' : ''
  if (!type) throw new Error('对话类型必须是 qa 或 case')
  const title = String(input.title || (type === 'case' ? '案例实训' : '智能答疑')).trim().slice(0, 120)
  const payload = input.payload && typeof input.payload === 'object' ? input.payload : {}
  const payloadSize = Buffer.byteLength(JSON.stringify(payload), 'utf8')
  if (payloadSize > 800_000) throw new Error('对话内容过大，请拆分后再保存')
  return { type, title: title || (type === 'case' ? '案例实训' : '智能答疑'), payload }
}

async function upsertConversation(input) {
  const normalized = normalizeConversation(input)
  const items = await readConversations()
  const now = new Date().toISOString()
  const existingIndex = input.id ? items.findIndex((item) => item.id === String(input.id)) : -1
  const existing = existingIndex >= 0 ? items[existingIndex] : null
  const item = {
    id: existing?.id || randomUUID(),
    type: normalized.type,
    title: normalized.title,
    payload: normalized.payload,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  }
  if (existingIndex >= 0) items.splice(existingIndex, 1, item)
  else items.push(item)
  await writeConversations(items)
  return item
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
}

function cleanHtmlText(fragment) {
  return decodeHtmlEntities(String(fragment || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

function classifyAcademicTitle(title) {
  if (/考试|补考|缓考|考务/.test(title)) return '考试通知'
  if (/转专业|学籍|毕业|选课|课表|注册/.test(title)) return '学生通知'
  if (/开课|课程|教学|培养|专业建设/.test(title)) return '教学动态'
  return '教务通知'
}

function extractAcademicNews(html) {
  const items = new Map()
  const anchorPattern = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
  let match
  while ((match = anchorPattern.exec(html)) !== null) {
    const rawHref = decodeHtmlEntities(match[1]).trim()
    let url
    try {
      url = new URL(rawHref, academicHomeUrl)
    } catch {
      continue
    }
    if (url.hostname !== 'jw.nau.edu.cn' || !/^\/20\d{2}\/\d{4}\/c\d+a\d+\/page\.htm$/i.test(url.pathname)) continue
    const title = cleanHtmlText(match[2])
    if (title.length < 4) continue
    const context = html.slice(Math.max(0, match.index - 420), Math.min(html.length, anchorPattern.lastIndex + 420))
    const dateMatch = context.match(/20\d{2}\s*[./-]\s*\d{1,2}\s*[./-]\s*\d{1,2}/)
    const pathDate = url.pathname.match(/^\/(20\d{2})\/(\d{2})(\d{2})\//)
    const date = pathDate
      ? `${pathDate[1]}-${pathDate[2]}-${pathDate[3]}`
      : dateMatch ? dateMatch[0].replace(/\s+/g, '').replace(/[./]/g, '-') : ''
    const item = { title, url: url.href, date, category: classifyAcademicTitle(title) }
    const previous = items.get(url.href)
    if (!previous || title.length > previous.title.length) items.set(url.href, item)
  }
  return [...items.values()]
    .sort((a, b) => (Date.parse(b.date || '') || 0) - (Date.parse(a.date || '') || 0))
    .slice(0, 12)
}

async function loadAcademicNews() {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 8000)
  try {
    const upstream = await fetch(academicHomeUrl, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': 'ShizhiXueban/1.0 academic-news-reader',
      },
    })
    if (!upstream.ok) throw new Error(`教务网站返回 HTTP ${upstream.status}`)
    const html = await upstream.text()
    return { sourceUrl: academicHomeUrl, fetchedAt: new Date().toISOString(), items: extractAcademicNews(html) }
  } finally {
    clearTimeout(timeout)
  }
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  })
  response.end(JSON.stringify(payload))
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => {
      body += chunk
      if (body.length > 2_000_000) reject(new Error('请求内容过大'))
    })
    request.on('end', () => resolve(body))
    request.on('error', reject)
  })
}

function getChatEndpoint(baseUrl) {
  const normalized = String(baseUrl || '').trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(normalized)) throw new Error('Base URL 必须以 http:// 或 https:// 开头')
  return normalized.endsWith('/chat/completions') ? normalized : `${normalized}/chat/completions`
}

function contentToText(value, depth = 0) {
  if (depth > 5) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value.map((item) => contentToText(item, depth + 1)).filter(Boolean).join('')
  }
  if (value && typeof value === 'object') {
    for (const key of ['text', 'content', 'output_text', 'value', 'answer', 'response']) {
      const text = contentToText(value[key], depth + 1)
      if (text) return text
    }
  }
  return ''
}

function firstText(...values) {
  for (const value of values) {
    const text = contentToText(value)
    if (text) return text
  }
  return ''
}

function normalizeSseResponse(rawText) {
  const packets = []
  let answer = ''
  let sawDelta = false
  for (const line of rawText.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    try {
      const packet = JSON.parse(payload)
      packets.push(packet)
      const choice = packet?.choices?.[0] || packet?.data?.choices?.[0]
      const deltaText = firstText(choice?.delta?.content, choice?.delta?.text, choice?.delta)
      if (deltaText) {
        answer += deltaText
        sawDelta = true
      } else if (!sawDelta) {
        const fullText = firstText(choice?.message?.content, choice?.message, choice?.text, packet?.output_text, packet?.content, packet?.text)
        if (fullText) answer = fullText
      }
    } catch {
      // Ignore non-JSON SSE comments or incomplete keep-alive lines.
    }
  }
  if (!answer) {
    for (const packet of [...packets].reverse()) {
      const choice = packet?.choices?.[0] || packet?.data?.choices?.[0]
      const fallback = firstText(choice?.message?.content, choice?.message, choice?.text, packet?.output_text, packet?.content, packet?.text)
      if (fallback) {
        answer = fallback
        break
      }
    }
  }
  const lastPacket = packets.at(-1) || {}
  const lastChoice = lastPacket?.choices?.[0] || {}
  return {
    id: lastPacket.id || '',
    object: 'chat.completion',
    created: lastPacket.created || Math.floor(Date.now() / 1000),
    model: lastPacket.model || '',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: answer },
      finish_reason: lastChoice.finish_reason || 'stop',
    }],
    usage: lastPacket.usage,
    _debug: answer ? undefined : {
      packetCount: packets.length,
      packetShapes: packets.slice(0, 5).map((packet) => ({
        topLevel: Object.keys(packet || {}),
        choice: packet?.choices?.[0] ? Object.keys(packet.choices[0]) : [],
        delta: packet?.choices?.[0]?.delta ? Object.keys(packet.choices[0].delta) : [],
      })),
    },
  }
}

const server = http.createServer(async (request, response) => {
  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    })
    response.end()
    return
  }

  const requestUrl = new URL(request.url || '/', 'http://127.0.0.1')
  if (request.method === 'GET' && requestUrl.pathname === '/api/academic-news') {
    try {
      sendJson(response, 200, await loadAcademicNews())
    } catch (error) {
      sendJson(response, 502, { error: { message: error?.name === 'AbortError' ? '教务网站响应超时' : error?.message || '教务网站暂时无法访问' } })
    }
    return
  }

  if (request.method === 'GET' && requestUrl.pathname === '/api/conversations') {
    try {
      const items = await readConversations()
      items.sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0))
      sendJson(response, 200, { items })
    } catch (error) {
      sendJson(response, 500, { error: { message: error?.message || '历史对话暂时无法读取' } })
    }
    return
  }

  if (request.method === 'POST' && requestUrl.pathname === '/api/conversations') {
    try {
      const item = await upsertConversation(JSON.parse(await readBody(request)))
      sendJson(response, 200, { item })
    } catch (error) {
      sendJson(response, 400, { error: { message: error?.message || '历史对话保存失败' } })
    }
    return
  }

  if (request.method === 'DELETE' && requestUrl.pathname.startsWith('/api/conversations/')) {
    const id = decodeURIComponent(requestUrl.pathname.slice('/api/conversations/'.length))
    try {
      const items = await readConversations()
      const nextItems = items.filter((item) => item.id !== id)
      if (nextItems.length === items.length) {
        sendJson(response, 404, { error: { message: '没有找到这条历史对话' } })
      } else {
        await writeConversations(nextItems)
        sendJson(response, 200, { ok: true })
      }
    } catch (error) {
      sendJson(response, 500, { error: { message: error?.message || '历史对话删除失败' } })
    }
    return
  }

  if (request.method !== 'POST' || request.url !== '/api/chat') {
    sendJson(response, 404, { error: { message: '本机代理只支持 POST /api/chat' } })
    return
  }

  try {
    const input = JSON.parse(await readBody(request))
    const endpoint = getChatEndpoint(input.baseUrl)
    if (!input.apiKey || !input.model || !Array.isArray(input.messages)) {
      sendJson(response, 400, { error: { message: '缺少 apiKey、model 或 messages' } })
      return
    }

    const apiKey = String(input.apiKey).replace(/^Bearer\s+/i, '').trim()
    const upstream = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: String(input.model).trim(),
        messages: input.messages,
        temperature: input.temperature ?? 0.4,
        max_tokens: input.max_tokens ?? 512,
        stream: false,
        ...(input.enable_thinking !== undefined ? { enable_thinking: input.enable_thinking } : {}),
        ...(input.chat_template_kwargs ? { chat_template_kwargs: input.chat_template_kwargs } : {}),
        ...(input.thinking ? { thinking: input.thinking } : {}),
      }),
    })

    const text = await upstream.text()
    const isSse = (upstream.headers.get('content-type') || '').includes('text/event-stream') || /^\s*data:/m.test(text)
    const responseBody = isSse ? JSON.stringify(normalizeSseResponse(text)) : text
    response.writeHead(upstream.status, {
      'Content-Type': isSse ? 'application/json; charset=utf-8' : (upstream.headers.get('content-type') || 'application/json; charset=utf-8'),
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
    })
    response.end(responseBody)
  } catch (error) {
    sendJson(response, 502, { error: { message: error?.message || '本机代理无法连接上游模型服务' } })
  }
})

server.listen(port, '127.0.0.1', () => {
  console.log(`审智学伴 API proxy listening on http://127.0.0.1:${port}`)
})
