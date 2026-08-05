import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

const initialProfile = {
  name: '林同学',
  grade: '大二',
  major: '审计学',
  goal: '参加审计案例竞赛',
  weeklyHours: 4,
}

const defaultModelConfig = {
  provider: 'OpenAI-compatible',
  baseUrl: 'https://api.openai.com/v1',
  model: '填写模型名称',
  apiKey: '',
  thinkingMode: 'disabled',
}

function getLocalApiEndpoint(pathname) {
  return import.meta.env.DEV ? `http://127.0.0.1:8787${pathname}` : pathname
}

const initialTopics = [
  { name: '审计风险', value: 84, tone: 'good' },
  { name: '内部控制', value: 72, tone: 'steady' },
  { name: '审计证据', value: 68, tone: 'steady' },
  { name: '审计抽样', value: 45, tone: 'weak' },
  { name: '数据分析', value: 38, tone: 'weak' },
]

const caseStudy = {
  id: 'inventory-growth-01',
  title: '存货余额异常增长',
  background: '华东制造公司本年度存货余额较上年增长 48%，但销售收入仅增长 6%。期末仓库中有部分产品积压超过 18 个月，管理层解释为“市场需求即将回升”。',
  questions: ['你认为最需要关注的风险是什么？', '你会优先获取哪些审计证据？'],
  instruction: '识别审计风险，并设计后续审计程序。',
}

const chatSeed = [
  {
    from: 'bot',
    text: '你好，我是审智学伴。告诉我你正在学习的知识点，或上传学习通错题记录，我会结合你的学习画像给出分层指导。',
  },
]

function getModelCapability(modelName) {
  const name = String(modelName || '').trim().toLowerCase()
  if (!name || name === '填写模型名称') {
    return { family: '未识别', support: 'unknown', label: '等待模型名称', detail: '填写模型名称后自动识别能力', normalMaxTokens: 3072, thinkingMaxTokens: 6144 }
  }

  if (/deepseek/.test(name)) {
    if (/(reasoner|r1|thinking)/.test(name)) {
      return { family: 'DeepSeek', support: 'forced', label: 'DeepSeek · 强制思考', detail: '该模型会始终生成思考过程，页面只展示最终答案', normalMaxTokens: 8192, thinkingMaxTokens: 8192 }
    }
    if (/deepseek-(chat|coder)/.test(name)) {
      return { family: 'DeepSeek', support: 'none', label: 'DeepSeek · 普通模式', detail: '旧版兼容模型按非思考模式调用', normalMaxTokens: 4096, thinkingMaxTokens: 4096 }
    }
    return { family: 'DeepSeek', support: 'toggle', label: 'DeepSeek · 支持思考开关', detail: '可在思考与快速回答之间切换', normalMaxTokens: 4096, thinkingMaxTokens: 8192 }
  }

  if (/qwen|qwq/.test(name)) {
    if (/(qwq|thinking|reasoning|r1)/.test(name)) {
      return { family: 'Qwen', support: 'forced', label: 'Qwen · 强制思考', detail: '该模型会始终生成思考过程，页面只展示最终答案', normalMaxTokens: 8192, thinkingMaxTokens: 8192 }
    }
    if (/qwen[-_ ]?3|qwen3/.test(name)) {
      return { family: 'Qwen', support: 'toggle', label: 'Qwen 3 · 支持思考开关', detail: '可在思考与快速回答之间切换', normalMaxTokens: 4096, thinkingMaxTokens: 8192 }
    }
    return { family: 'Qwen', support: 'none', label: 'Qwen · 普通模式', detail: '按非思考模型处理，不发送思考参数', normalMaxTokens: 4096, thinkingMaxTokens: 4096 }
  }

  return { family: '通用模型', support: 'unknown', label: '通用模型 · 能力未识别', detail: '按普通模式调用；如需思考参数可再补充模型规则', normalMaxTokens: 3072, thinkingMaxTokens: 6144 }
}

function getModelPolicy(modelName, thinkingMode = 'disabled') {
  const capability = getModelCapability(modelName)
  const thinking = capability.support === 'forced' || (capability.support === 'toggle' && thinkingMode === 'enabled')
  return { ...capability, thinking, maxTokens: thinking ? capability.thinkingMaxTokens : capability.normalMaxTokens }
}

function buildTutorSystemPrompt(profile, topics) {
  const weakTopics = topics.filter((topic) => topic.value < 60).map((topic) => `${topic.name}（${topic.value}%）`).join('、')
  return `你是“审智学伴”，一名面向审计学专业大学生的中文 AI 学习导师。
学生画像：${profile.grade}、${profile.major}、学习目标是${profile.goal}、每周可学习${profile.weeklyHours}小时。
学生当前薄弱知识点：${weakTopics || '暂无明确薄弱点'}。
回答要求：必须使用简体中文，除非学生明确要求英文；只输出面向学生的最终答案，不要把思考过程、内部提示、英文推理、<think>标签、Final Output Generation、Ready 等内部文本展示给学生；回答要清晰、具体、适合大学生理解；不要编造不存在的学校制度、课程资料或引用来源；不要直接替学生完成需要独立作答的作业。`
}

function contentToText(value, depth = 0) {
  if (depth > 5) return ''
  if (typeof value === 'string') return value.trim()
  if (Array.isArray(value)) {
    return value.map((item) => contentToText(item, depth + 1)).filter(Boolean).join('\n').trim()
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

function cleanModelAnswer(text) {
  let cleaned = String(text || '').replace(/\r\n/g, '\n').trim()
  const closingThink = cleaned.lastIndexOf('</think>')
  if (closingThink >= 0) {
    const finalText = cleaned.slice(closingThink + '</think>'.length).trim()
    if (finalText) cleaned = finalText
  }
  cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  cleaned = cleaned.replace(/^Final Output Generation\s*:\s*/i, '').trim()
  return cleaned
}

function extractMarkdownSection(text, heading) {
  const source = String(text || '').replace(/\r\n/g, '\n')
  const match = source.match(new RegExp(`(?:^|\\n)#{1,4}\\s*${heading}\\s*\\n([\\s\\S]*?)(?=\\n#{1,4}\\s|$)`, 'i'))
  return match?.[1]?.trim() || ''
}

function extractNextPractice(text) {
  const nextPractice = extractMarkdownSection(text, '下一步练习')
  if (nextPractice) return nextPractice
  const nextAction = extractMarkdownSection(text, '下一步动作')
  return nextAction ? `请将“${nextAction}”进一步拆解为可执行的审计步骤，并说明每一步要验证什么。` : ''
}

function removeNextPracticeSection(text) {
  const source = String(text || '').replace(/\r\n/g, '\n')
  const match = source.match(/(?:^|\n)#{1,4}\s*下一步练习\s*\n([\s\S]*?)(?=\n#{1,4}\s|$)/i)
  return match ? source.slice(0, match.index).trim() : source
}

function finalTextAfterThinking(text) {
  const raw = String(text || '').trim()
  const closingThink = raw.lastIndexOf('</think>')
  return closingThink >= 0 ? raw.slice(closingThink + '</think>'.length).trim() : ''
}

function extractModelAnswer(data) {
  const choice = data?.choices?.[0] || data?.data?.choices?.[0]
  const answer = firstText(
    choice?.message?.content,
    choice?.message,
    choice?.text,
    data?.output_text,
    data?.content,
    data?.text,
    data?.answer,
    data?.output,
  )
  if (answer) return answer
  return finalTextAfterThinking(firstText(choice?.message?.reasoning_content, choice?.reasoning_content, data?.reasoning_content))
}

function normalizeSseText(rawText) {
  let answer = ''
  let sawDelta = false
  for (const line of rawText.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    try {
      const packet = JSON.parse(payload)
      const choice = packet?.choices?.[0] || packet?.data?.choices?.[0]
      const deltaText = firstText(choice?.delta?.content, choice?.delta?.text, choice?.delta)
      if (deltaText) {
        answer += deltaText
        sawDelta = true
      } else if (!sawDelta) {
        answer = firstText(choice?.message?.content, choice?.message, choice?.text, packet?.output_text, packet?.content, packet?.text) || answer
      }
    } catch {
      // Ignore SSE comments or incomplete keep-alive lines.
    }
  }
  return answer ? { choices: [{ message: { role: 'assistant', content: answer } }] } : null
}

function describeModelResponse(data) {
  const topLevel = data && typeof data === 'object' ? Object.keys(data).slice(0, 8).join(', ') : '非 JSON 响应'
  const choice = data?.choices?.[0]
  const choiceFields = choice && typeof choice === 'object' ? Object.keys(choice).slice(0, 8).join(', ') : '无 choices[0]'
  const messageFields = choice?.message && typeof choice.message === 'object' ? Object.keys(choice.message).slice(0, 8).join(', ') : '无 message'
  const finishHint = choice?.finish_reason === 'length' ? '；结束原因：length（输出长度达到上限）' : ''
  const debug = data?._debug ? `；流式包数量：${data._debug.packetCount}` : ''
  return `模型已返回标准响应，但未找到可显示的最终答案（顶层字段：${topLevel || '空'}；首个结果字段：${choiceFields}；message 字段：${messageFields}${finishHint}${debug}）`
}

const sampleQuestions = [
  { title: '审计抽样的基本方法', topic: '审计抽样', wrong: 3, total: 5 },
  { title: '控制测试与实质性程序', topic: '内部控制', wrong: 1, total: 5 },
  { title: '存货跌价风险识别', topic: '审计风险', wrong: 1, total: 5 },
]

function App() {
  const [active, setActive] = useState('overview')
  const [profile, setProfile] = useState(initialProfile)
  const [topics, setTopics] = useState(initialTopics)
  const [chat, setChat] = useState(chatSeed)
  const [draft, setDraft] = useState('')
  const [qaConversationId, setQaConversationId] = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const [caseReview, setCaseReview] = useState(null)
  const [caseReviewLoading, setCaseReviewLoading] = useState(false)
  const [caseContext, setCaseContext] = useState(null)
  const [caseFollowUp, setCaseFollowUp] = useState(null)
  const [caseFollowUpLoading, setCaseFollowUpLoading] = useState(false)
  const [caseNextPractice, setCaseNextPractice] = useState(null)
  const [caseNextPracticeLoading, setCaseNextPracticeLoading] = useState(false)
  const [casePracticeRounds, setCasePracticeRounds] = useState([])
  const [caseDialogue, setCaseDialogue] = useState([])
  const [caseDraft, setCaseDraft] = useState(null)
  const [imported, setImported] = useState(false)
  const [notice, setNotice] = useState('')
  const [academicNews, setAcademicNews] = useState([])
  const [academicLoading, setAcademicLoading] = useState(true)
  const [academicError, setAcademicError] = useState('')
  const [academicRefreshKey, setAcademicRefreshKey] = useState(0)
  const [modelConfig, setModelConfig] = useState(() => {
    try {
      return { ...defaultModelConfig, ...JSON.parse(localStorage.getItem('shizhixueban:model-config') || '{}') }
    } catch {
      return defaultModelConfig
    }
  })
  const [keyVisible, setKeyVisible] = useState(false)
  const [modelSaved, setModelSaved] = useState(Boolean(localStorage.getItem('shizhixueban:model-config')))
  const [taskMenuOpen, setTaskMenuOpen] = useState(false)
  const [conversations, setConversations] = useState([])
  const [conversationsLoading, setConversationsLoading] = useState(false)
  const [conversationsError, setConversationsError] = useState('')
  const [conversationsRefreshKey, setConversationsRefreshKey] = useState(0)
  const [selectedConversation, setSelectedConversation] = useState(null)
  const fileRef = useRef(null)

  const weakestTopic = useMemo(
    () => [...topics].sort((a, b) => a.value - b.value)[0],
    [topics],
  )

  useEffect(() => {
    let cancelled = false
    const endpoint = import.meta.env.DEV ? 'http://127.0.0.1:8787/api/academic-news' : '/api/academic-news'
    setAcademicLoading(true)
    setAcademicError('')
    fetch(endpoint)
      .then(async (response) => {
        const data = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(data?.error?.message || `教务网站暂时无法访问（HTTP ${response.status}）`)
        return data
      })
      .then((data) => {
        if (cancelled) return
        setAcademicNews(Array.isArray(data.items) ? data.items : [])
      })
      .catch((error) => {
        if (cancelled) return
        setAcademicError(error?.message || '教务动态暂时无法加载')
      })
      .finally(() => {
        if (!cancelled) setAcademicLoading(false)
      })
    return () => { cancelled = true }
  }, [academicRefreshKey])

  useEffect(() => {
    if (!taskMenuOpen) return undefined
    function closeTaskMenu(event) {
      const target = event.target
      if (target instanceof Element && !target.closest('.task-menu-anchor')) {
        setTaskMenuOpen(false)
      }
    }
    function closeOnEscape(event) {
      if (event.key === 'Escape') setTaskMenuOpen(false)
    }
    document.addEventListener('pointerdown', closeTaskMenu)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeTaskMenu)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [taskMenuOpen])

  useEffect(() => {
    if (active !== 'library') return undefined
    let cancelled = false
    setConversationsLoading(true)
    setConversationsError('')
    fetch(getLocalApiEndpoint('/api/conversations'))
      .then(async (response) => {
        const data = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(data?.error?.message || `历史对话读取失败（HTTP ${response.status}）`)
        return data
      })
      .then((data) => {
        if (!cancelled) setConversations(Array.isArray(data.items) ? data.items : [])
      })
      .catch((error) => {
        if (!cancelled) setConversationsError(error?.message || '历史对话暂时无法读取')
      })
      .finally(() => {
        if (!cancelled) setConversationsLoading(false)
      })
    return () => { cancelled = true }
  }, [active, conversationsRefreshKey])

  const navItems = [
    ['overview', '学习总览', '⌂'],
    ['library', '对话库', '▤'],
    ['portrait', '我的画像', '◌'],
    ['qa', '智能答疑', '✦'],
    ['case', '案例实训', '▣'],
    ['plan', '学习计划', '✓'],
    ['tasks', '学习任务', '◷'],
    ['model', '模型接入', '⚙'],
  ]

  function notify(message) {
    setNotice(message)
    window.setTimeout(() => setNotice(''), 2800)
  }

  function startNewQaConversation() {
    setQaConversationId('')
    setChat(chatSeed)
    setDraft('')
  }

  function startNewCaseConversation() {
    setCaseDraft(null)
    setCaseContext(null)
    setCaseReview(null)
    setCaseFollowUp(null)
    setCaseNextPractice(null)
    setCasePracticeRounds([])
    setCaseDialogue([])
  }

  function navigateTo(target) {
    setTaskMenuOpen(false)
    if (target === 'qa') startNewQaConversation()
    if (target === 'case') startNewCaseConversation()
    setActive(target)
  }

  function navigateFromTask(target) {
    navigateTo(target)
  }

  async function saveConversationRecord(record) {
    const response = await fetch(getLocalApiEndpoint('/api/conversations'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(record),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data?.error?.message || `对话保存失败（HTTP ${response.status}）`)
    const item = data.item
    setConversations((current) => [item, ...current.filter((conversation) => conversation.id !== item.id)].sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0)))
    return item
  }

  async function saveQaConversation({ id, chat: nextChat }) {
    try {
      const persistedChat = nextChat.filter((message) => !message.error)
      const item = await saveConversationRecord({ id, type: 'qa', title: persistedChat.find((message) => message.from === 'user')?.text?.slice(0, 36) || '智能答疑', payload: { chat: persistedChat } })
      notify('智能答疑已保存到对话库')
      return item
    } catch (error) {
      notify(error?.message || '智能答疑保存失败')
      return null
    }
  }

  async function saveCaseConversation({ id, riskAnswer, evidenceAnswer, review, followUpResult, nextPracticeResult, nextPracticeAnswer, practiceRounds, context = caseContext, dialogue = caseDialogue, caseSnapshot = caseStudy }) {
    try {
      const item = await saveConversationRecord({
        id,
        type: 'case',
        title: '案例实训 · 存货余额异常增长',
        payload: {
          case: caseSnapshot,
          riskAnswer,
          evidenceAnswer,
          review,
          context: context || { riskAnswer, evidenceAnswer, review: review?.text || '' },
          followUpResult,
          nextPracticeResult,
          nextPracticeAnswer,
          practiceRounds,
          dialogue,
        },
      })
      notify('案例实训已保存到对话库')
      return item
    } catch (error) {
      notify(error?.message || '案例实训保存失败')
      return null
    }
  }

  async function answerConversationQuestion(chatHistory, question) {
    const history = (Array.isArray(chatHistory) ? chatHistory : [])
      .filter((item) => !item.error && item.text?.trim())
      .slice(-6)
      .map((item) => ({ role: item.from === 'user' ? 'user' : 'assistant', content: item.text.slice(0, 1200) }))
    return requestModelAnswer([{ role: 'system', content: buildTutorSystemPrompt(profile, topics) }, ...history, { role: 'user', content: question }])
  }

  async function answerCaseConversationQuestion(item, dialogue, question) {
    const payload = item?.payload || {}
    const snapshot = payload.case || caseStudy
    const history = (Array.isArray(dialogue) ? dialogue : [])
      .filter((message) => !message.error && message.text?.trim())
      .slice(-8)
      .map((message) => `${message.from === 'user' ? '学生' : '审智学伴'}：${message.text.slice(0, 1000)}`)
      .join('\n')
    const prompt = `你正在案例实训对话框中辅导学生。
案例标题：${snapshot.title}
案例背景：${snapshot.background}
案例问题：${snapshot.questions.join('；')}
案例要求：${snapshot.instruction}
学生原始作答：
- 风险判断：${payload.riskAnswer || '未填写'}
- 审计证据：${payload.evidenceAnswer || '未填写'}
已有 AI 点评：${payload.review?.text || payload.review?.reviewText || '暂无'}
历史追问：
${history || '暂无'}

学生当前问题：${question}

请直接用简体中文回答，先给清晰结论，再给审计理由和下一步验证方向；不要输出思考过程、内部提示或 <think> 标签，也不要替学生完成整道案例。`
    return requestModelAnswer([
      { role: 'system', content: `${buildTutorSystemPrompt(profile, topics)}\n你是案例实训中的追问辅导老师。` },
      { role: 'user', content: prompt },
    ])
  }

  async function saveCaseConversationThread({ id, title, payload }) {
    try {
      const item = await saveConversationRecord({
        id,
        type: 'case',
        title: title || '案例实训 · 存货余额异常增长',
        payload: { ...payload, case: payload?.case || caseStudy },
      })
      notify('案例实训对话已保存')
      return item
    } catch (error) {
      notify(error?.message || '案例实训对话保存失败')
      return null
    }
  }

  async function deleteConversation(id) {
    try {
      const response = await fetch(`${getLocalApiEndpoint('/api/conversations')}/${encodeURIComponent(id)}`, { method: 'DELETE' })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data?.error?.message || '历史对话删除失败')
      setConversations((current) => current.filter((conversation) => conversation.id !== id))
      notify('历史对话已删除')
    } catch (error) {
      notify(error?.message || '历史对话删除失败')
    }
  }

  function openConversation(item) {
    const payload = item?.payload || {}
    if (item.type === 'qa') {
      setChat(Array.isArray(payload.chat) && payload.chat.length ? payload.chat : chatSeed)
      setDraft('')
      setQaConversationId(item.id)
      setActive('qa')
      notify('已打开这段智能答疑，可继续提问')
      return
    }
    const review = payload.review || null
    setCaseDraft({ conversationId: item.id, riskAnswer: payload.riskAnswer || '', evidenceAnswer: payload.evidenceAnswer || '', nextPracticeAnswer: payload.nextPracticeAnswer || '' })
    setCaseContext(payload.context || { riskAnswer: payload.riskAnswer || '', evidenceAnswer: payload.evidenceAnswer || '', review: review?.text || '' })
    setCaseReview(review)
    setCaseFollowUp(payload.followUpResult || null)
    setCaseNextPractice(payload.nextPracticeResult || null)
    setCasePracticeRounds(Array.isArray(payload.practiceRounds) ? payload.practiceRounds : [])
    setCaseDialogue(Array.isArray(payload.dialogue) ? payload.dialogue : [])
    setActive('case')
    notify('已打开这份案例实训，可继续作答或追问')
  }

  function openConversationDialog(item) {
    setSelectedConversation(item)
  }

  function continueConversation(item) {
    setSelectedConversation(null)
    openConversation(item)
  }

  function handleImport(event) {
    const file = event.target.files?.[0]
    if (!file) return
    setImported(true)
    setTopics((current) =>
      current.map((topic) =>
        topic.name === '审计抽样'
          ? { ...topic, value: Math.max(0, topic.value - 4) }
          : topic,
      ),
    )
    notify(`已读取「${file.name}」，识别出 12 条学习记录`)
  }

  async function requestModelAnswer(messages) {
    if (!modelConfig.apiKey.trim()) {
      setActive('model')
      throw new Error('请先在“模型接入”中填写 API Key')
    }
    if (!modelConfig.baseUrl.trim() || !modelConfig.model.trim() || modelConfig.model === '填写模型名称') {
      setActive('model')
      throw new Error('请先完善 Base URL 和模型名称')
    }

    const modelPolicy = getModelPolicy(modelConfig.model, modelConfig.thinkingMode)
    const isQwenModel = modelPolicy.family === 'Qwen'
    const isDeepSeekModel = modelPolicy.family === 'DeepSeek'
    const requestMessages = messages.map((message, index) => {
      const isLastUserMessage = index === messages.length - 1 && message.role === 'user'
      if (isQwenModel && !modelPolicy.thinking && isLastUserMessage && !String(message.content).includes('/no_think')) {
        return { ...message, content: `${message.content}\n/no_think` }
      }
      return message
    })
    const requestBody = {
      baseUrl: modelConfig.baseUrl,
      apiKey: modelConfig.apiKey,
      model: modelConfig.model.trim(),
      messages: requestMessages,
      max_tokens: modelPolicy.maxTokens,
      ...(isDeepSeekModel && !modelPolicy.thinking ? { temperature: 0.4 } : {}),
      ...(!isDeepSeekModel ? { temperature: 0.4 } : {}),
      ...(isQwenModel && modelPolicy.support !== 'none'
        ? { enable_thinking: modelPolicy.thinking, chat_template_kwargs: { enable_thinking: modelPolicy.thinking } }
        : {}),
      ...(isDeepSeekModel ? { thinking: { type: modelPolicy.thinking ? 'enabled' : 'disabled' } } : {}),
    }
    const proxyEndpoint = import.meta.env.DEV ? 'http://127.0.0.1:8787/api/chat' : '/api/chat'
    const response = await fetch(proxyEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    })
    const rawResponse = await response.text()
    let data = {}
    try {
      const trimmedResponse = rawResponse.trim()
      data = trimmedResponse.startsWith('data:') ? (normalizeSseText(trimmedResponse) || { raw_text: rawResponse }) : (trimmedResponse ? JSON.parse(trimmedResponse) : {})
    } catch {
      data = { raw_text: rawResponse }
    }
    if (!response.ok) {
      if (response.status === 429) {
        const retryAfter = response.headers.get('retry-after')
        throw new Error(`用户请求 TPM 超限，请稍后再试${retryAfter ? `（建议等待 ${retryAfter} 秒）` : ''}；系统已按模型能力限制上下文和输出长度。`)
      }
      throw new Error(data?.error?.message || data?.message || `请求失败（HTTP ${response.status}）`)
    }
    const answer = cleanModelAnswer(extractModelAnswer(data))
    if (!answer) throw new Error(data?.raw_text ? `上游返回的不是 JSON：${data.raw_text.slice(0, 160)}` : describeModelResponse(data))
    return answer
  }

  async function sendQuestion(question = draft) {
    const text = question.trim()
    if (!text) return
    const history = chat.filter((item) => !item.error && item.text?.trim()).slice(-2).map((item) => ({
      role: item.from === 'user' ? 'user' : 'assistant',
      content: item.text.slice(0, 800),
    }))
    const userMessage = { from: 'user', text }
    const chatWithUser = [...chat, userMessage]
    setChat(chatWithUser)
    setDraft('')
    setChatLoading(true)
    try {
      const answer = await requestModelAnswer([{ role: 'system', content: buildTutorSystemPrompt(profile, topics) }, ...history, { role: 'user', content: text }])
      const nextChat = [...chatWithUser, { from: 'bot', text: answer }]
      setChat(nextChat)
      const saved = await saveQaConversation({ id: qaConversationId || undefined, chat: nextChat })
      if (saved?.id) setQaConversationId(saved.id)
    } catch (error) {
      const message = error?.message || '无法连接模型服务'
      setChat((current) => [...current, { from: 'bot', error: true, text: `这次请求没有成功：${message}\n\n请检查本机代理是否已启动，以及 Base URL、模型名称和 API Key 是否正确。` }])
    } finally {
      setChatLoading(false)
    }
  }

  async function reviewCase({ riskAnswer, evidenceAnswer }) {
    if (!riskAnswer.trim() && !evidenceAnswer.trim()) {
      notify('请先填写至少一项案例判断，再提交 AI 点评')
      return
    }
    setCaseReview(null)
    setCaseDraft((current) => ({ ...(current || {}), riskAnswer, evidenceAnswer }))
    setCaseContext(null)
    setCaseFollowUp(null)
    setCaseNextPractice(null)
    setCasePracticeRounds([])
    setCaseReviewLoading(true)
    const casePrompt = `请点评下面这份审计案例作答。\n\n案例背景：华东制造公司本年度存货余额较上年增长 48%，但销售收入仅增长 6%。期末仓库中有部分产品积压超过 18 个月，管理层解释为“市场需求即将回升”。\n\n学生对第一问“最需要关注的风险”的回答：${riskAnswer || '未作答'}\n学生对第二问“优先获取哪些审计证据”的回答：${evidenceAnswer || '未作答'}\n\n请按以下结构输出：\n### 结论\n判断学生回答的主要风险方向是否正确。\n### 做得好的地方\n列出具体优点；如果没有，请明确说明。\n### 需要补充\n指出遗漏的风险或审计证据，并解释原因。\n### 下一步练习\n给出一个简短的追问，帮助学生继续思考。`
    try {
      const answer = await requestModelAnswer([
        { role: 'system', content: `${buildTutorSystemPrompt(profile, topics)}\n你现在还要承担案例实训点评老师的角色，点评要具体、鼓励但不能替学生完成作答。` },
        { role: 'user', content: casePrompt },
      ])
      const nextContext = { riskAnswer, evidenceAnswer, review: answer }
      const nextReview = { text: answer, reviewText: removeNextPracticeSection(answer), nextPractice: extractNextPractice(answer) }
      setCaseContext(nextContext)
      setCaseReview(nextReview)
      const saved = await saveCaseConversation({ id: caseDraft?.conversationId, riskAnswer, evidenceAnswer, review: nextReview, context: nextContext, followUpResult: null, nextPracticeResult: null, nextPracticeAnswer: '', practiceRounds: [], dialogue: caseDialogue })
      if (saved?.id) setCaseDraft((current) => ({ ...(current || {}), conversationId: saved.id, riskAnswer, evidenceAnswer }))
      completeTask()
      notify('AI 案例点评已生成')
    } catch (error) {
      setCaseReview({ error: error?.message || '无法连接模型服务' })
    } finally {
      setCaseReviewLoading(false)
    }
  }

  async function askCaseFollowUp(question) {
    const text = String(question || '').trim()
    if (!text || !caseContext) return
    setCaseFollowUp(null)
    setCaseFollowUpLoading(true)
    const followUpPrompt = `这是同一个审计案例的继续追问。

案例背景：华东制造公司本年度存货余额较上年增长 48%，但销售收入仅增长 6%；期末有产品积压超过 18 个月，管理层解释为“市场需求即将回升”。
学生原始回答：
- 风险判断：${caseContext.riskAnswer || '未作答'}
- 审计证据：${caseContext.evidenceAnswer || '未作答'}
此前 AI 点评：${caseContext.review.slice(0, 5000)}
此前已经完成的练习轮次：${casePracticeRounds.slice(-5).map((round, index) => `第${index + 1}轮题目：${round.question}\n学生回答：${round.answer}\n反馈：${round.feedback?.text || ''}`).join('\n\n') || '暂无'}

学生现在的追问：${text}

请直接回答这个追问，使用简体中文，控制在 3—5 段；如果追问涉及判断，请先给结论，再说明审计理由和下一步验证方式。不要输出思考过程或内部提示。`
    try {
      const answer = await requestModelAnswer([
        { role: 'system', content: `${buildTutorSystemPrompt(profile, topics)}\n你现在是案例实训中的追问辅导老师，要帮助学生继续推理，但不要替学生完成整道案例。` },
        { role: 'user', content: followUpPrompt },
      ])
      const nextFollowUp = { text: answer }
      setCaseFollowUp(nextFollowUp)
      const saved = await saveCaseConversation({ id: caseDraft?.conversationId, riskAnswer: caseContext.riskAnswer, evidenceAnswer: caseContext.evidenceAnswer, review: caseReview, context: caseContext, followUpResult: nextFollowUp, nextPracticeResult: caseNextPractice, nextPracticeAnswer: '', practiceRounds: casePracticeRounds, dialogue: caseDialogue })
      if (saved?.id) setCaseDraft((current) => ({ ...(current || {}), conversationId: saved.id }))
    } catch (error) {
      setCaseFollowUp({ error: error?.message || '无法连接模型服务' })
    } finally {
      setCaseFollowUpLoading(false)
    }
  }

  async function submitCaseNextPractice({ question, answer }) {
    const practiceQuestion = String(question || '').trim()
    const practiceAnswer = String(answer || '').trim()
    if (!practiceQuestion || !practiceAnswer || !caseContext) return
    setCaseNextPractice(null)
    setCaseNextPracticeLoading(true)
    const practicePrompt = `请评价学生对下一步审计练习的作答。

案例背景：华东制造公司存货余额增长 48%，销售收入仅增长 6%，并存在积压超过 18 个月的产品。
此前案例作答：风险判断：${caseContext.riskAnswer || '未作答'}；审计证据：${caseContext.evidenceAnswer || '未作答'}。
此前 AI 点评：${caseContext.review.slice(0, 5000)}

下一步练习题目：${practiceQuestion}
学生本次作答：${practiceAnswer}

请按以下结构输出：
### 练习反馈
判断本次作答是否抓住了关键审计逻辑。
### 可以补充
指出一个最重要的遗漏，并用简短理由解释。
### 下一步动作
给出一个具体的审计验证动作或思考方向。
### 下一步练习
必须再给出一道新的、比本轮更具体的可作答问题，让学生可以继续下一轮练习；不要只写建议，也不要直接给出答案。不要输出思考过程，不要直接代写完整答案。`
    try {
      const feedback = await requestModelAnswer([
        { role: 'system', content: `${buildTutorSystemPrompt(profile, topics)}\n你现在是案例实训的练习批改老师，反馈要具体、鼓励且适合大学生理解。` },
        { role: 'user', content: practicePrompt },
      ])
      const nextQuestion = extractNextPractice(feedback) || '请根据本轮反馈，进一步写出三个可执行的审计验证步骤，并说明每一步对应的审计目标。'
      const nextRound = { question: practiceQuestion, answer: practiceAnswer, feedback: { text: feedback, reviewText: removeNextPracticeSection(feedback) }, nextQuestion }
      const nextRounds = [...casePracticeRounds, nextRound]
      setCasePracticeRounds(nextRounds)
      setCaseNextPractice(null)
      const saved = await saveCaseConversation({ id: caseDraft?.conversationId, riskAnswer: caseContext.riskAnswer, evidenceAnswer: caseContext.evidenceAnswer, review: caseReview, context: caseContext, followUpResult: caseFollowUp, nextPracticeResult: null, nextPracticeAnswer: '', practiceRounds: nextRounds, dialogue: caseDialogue })
      if (saved?.id) setCaseDraft((current) => ({ ...(current || {}), conversationId: saved.id }))
      notify('下一步练习反馈已生成')
    } catch (error) {
      setCaseNextPractice({ error: error?.message || '无法连接模型服务' })
    } finally {
      setCaseNextPracticeLoading(false)
    }
  }

  function saveProfile(event) {
    event.preventDefault()
    notify('学习画像已更新，推荐内容会随之调整')
    setActive('overview')
  }

  function completeTask() {
    setTopics((current) =>
      current.map((topic) =>
        topic.name === '审计抽样' ? { ...topic, value: Math.min(100, topic.value + 8) } : topic,
      ),
    )
    notify('练习已完成，审计抽样掌握度提升 8%')
  }

  function saveModelConfig(event) {
    event.preventDefault()
    if (!modelConfig.apiKey.trim()) {
      notify('请先填写 API Key')
      return
    }
    localStorage.setItem('shizhixueban:model-config', JSON.stringify(modelConfig))
    setModelSaved(true)
    notify('模型配置已保存在当前浏览器')
  }

  function clearModelConfig() {
    localStorage.removeItem('shizhixueban:model-config')
    setModelConfig(defaultModelConfig)
    setModelSaved(false)
    setKeyVisible(false)
    notify('模型配置已清除')
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">审</div>
          <div>
            <strong>审智学伴</strong>
            <span>Audit Learning Copilot</span>
          </div>
        </div>
        <div className="profile-mini">
          <div className="avatar">林</div>
          <div>
            <strong>{profile.name}</strong>
            <span>{profile.grade} · {profile.major}</span>
          </div>
          <button className="icon-button" onClick={() => setActive('portrait')} aria-label="编辑画像">⋯</button>
        </div>
        <nav className="nav-list">
          {navItems.map(([key, label, icon]) => (
            <button key={key} className={`nav-item ${active === key ? 'active' : ''}`} onClick={() => navigateTo(key)}>
              <span className="nav-icon">{icon}</span>{label}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="privacy-note"><span>●</span> 仅使用你主动提供的学习信息</div>
          <button className="help-link" onClick={() => notify('首版支持 CSV、Excel 或错题截图导入')}>？ 数据如何使用</button>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div>
            <span className="eyebrow">PERSONALIZED AUDIT LEARNING</span>
            <h1>{active === 'overview' ? `早上好，${profile.name}` : navItems.find((item) => item[0] === active)?.[1]}</h1>
          </div>
          <div className="top-actions">
            <button className="import-button" onClick={() => fileRef.current?.click()}><span>↥</span> 导入学习通记录</button>
            <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls,.json,.png,.jpg,.jpeg,.pdf" onChange={handleImport} hidden />
            <div className="task-menu-anchor">
              <button className="notification-button" onClick={() => setTaskMenuOpen((open) => !open)} aria-label="查看剩余学习任务" aria-haspopup="dialog" aria-expanded={taskMenuOpen}>♢<i /></button>
              {taskMenuOpen && <div className="task-popover" role="dialog" aria-label="剩余学习任务">
                <div className="task-popover-heading"><div><span className="card-kicker">TODAY</span><strong>还有 3 项学习任务</strong></div><button className="popover-close" onClick={() => setTaskMenuOpen(false)} aria-label="关闭任务面板">×</button></div>
                <div className="task-popover-list">
                  <button className="task-popover-item" onClick={() => navigateFromTask('qa')}><span className="task-popover-dot blue" /><span><strong>复习审计抽样基础概念</strong><small>智能答疑 · 15 分钟</small></span><em>→</em></button>
                  <button className="task-popover-item" onClick={() => navigateFromTask('case')}><span className="task-popover-dot orange" /><span><strong>完成存货异常增长案例</strong><small>案例实训 · 20 分钟</small></span><em>→</em></button>
                  <button className="task-popover-item" onClick={() => navigateFromTask('plan')}><span className="task-popover-dot green" /><span><strong>查看本周学习计划</strong><small>进度复盘 · 10 分钟</small></span><em>→</em></button>
                </div>
                <button className="task-popover-footer" onClick={() => navigateFromTask('tasks')}>查看全部学习任务 <span>→</span></button>
              </div>}
            </div>
          </div>
        </header>

        {active === 'overview' && <Overview profile={profile} topics={topics} weakestTopic={weakestTopic} imported={imported} academicNews={academicNews} academicLoading={academicLoading} academicError={academicError} onRefreshAcademic={() => setAcademicRefreshKey((value) => value + 1)} onImport={() => fileRef.current?.click()} onNavigate={navigateTo} onComplete={completeTask} />}
        {active === 'library' && <ConversationLibrary conversations={conversations} loading={conversationsLoading} error={conversationsError} onRefresh={() => setConversationsRefreshKey((value) => value + 1)} onOpen={openConversationDialog} onDelete={deleteConversation} />}
        {active === 'tasks' && <Tasks onNavigate={navigateTo} onComplete={completeTask} />}
        {active === 'portrait' && <Portrait profile={profile} setProfile={setProfile} onSave={saveProfile} topics={topics} />}
        {active === 'qa' && <Qa chat={chat} draft={draft} setDraft={setDraft} onSend={sendQuestion} loading={chatLoading} onNewConversation={startNewQaConversation} />}
        {active === 'case' && <CaseTraining onReview={reviewCase} loading={caseReviewLoading} result={caseReview} initialAnswers={caseDraft} practiceRounds={casePracticeRounds} onNewConversation={startNewCaseConversation} onFollowUp={askCaseFollowUp} followUpLoading={caseFollowUpLoading} followUpResult={caseFollowUp} onNextPractice={submitCaseNextPractice} nextPracticeLoading={caseNextPracticeLoading} nextPracticeResult={caseNextPractice} />}
        {active === 'plan' && <Plan topics={topics} onNavigate={navigateTo} onComplete={completeTask} />}
        {active === 'model' && <ModelSettings config={modelConfig} setConfig={setModelConfig} keyVisible={keyVisible} setKeyVisible={setKeyVisible} saved={modelSaved} onSave={saveModelConfig} onClear={clearModelConfig} />}
      </main>
      {selectedConversation && <InteractiveConversationDialog item={selectedConversation} onClose={() => setSelectedConversation(null)} onAskQa={answerConversationQuestion} onAskCase={answerCaseConversationQuestion} onSaveQa={saveQaConversation} onSaveCase={saveCaseConversationThread} />}
      {notice && <div className="toast">{notice}</div>}
    </div>
  )
}

function ModelSettings({ config, setConfig, keyVisible, setKeyVisible, saved, onSave, onClear }) {
  const policy = getModelPolicy(config.model, config.thinkingMode)
  const toggleThinking = () => {
    if (policy.support !== 'toggle') return
    setConfig({ ...config, thinkingMode: policy.thinking ? 'disabled' : 'enabled' })
  }

  return (
    <div className="single-column">
      <section className="panel model-card">
        <div className="section-heading">
          <div><span className="card-kicker">MODEL CONNECTION</span><h3>模型接入</h3></div>
          <span className={`status-pill ${saved ? 'live' : ''}`}>{saved ? '● 已配置' : '未配置'}</span>
        </div>
        <div className="model-intro">
          <div className="model-intro-icon">✦</div>
          <div><strong>接入你自己的大模型 API</strong><p>用于驱动智能答疑、案例点评和学习计划生成。API Key 只保存在当前浏览器的本地存储中，不会写入项目代码。</p></div>
        </div>
        <div className="model-capability">
          <div className="capability-copy">
            <span className="card-kicker">AUTO ADAPTATION</span>
            <strong>{policy.label}</strong>
            <p>{policy.detail} · 普通回答上限 {policy.normalMaxTokens} tokens，思考模式上限 {policy.thinkingMaxTokens} tokens。</p>
          </div>
          <label className={`thinking-toggle ${policy.support !== 'toggle' ? 'disabled' : ''}`}>
            <span className="thinking-toggle-copy"><strong>思考模式</strong><small>{policy.support === 'forced' ? '模型强制开启' : policy.support === 'none' ? '模型不支持' : policy.support === 'unknown' ? '暂未识别' : policy.thinking ? '已开启' : '已关闭'}</small></span>
            <input type="checkbox" checked={policy.thinking} disabled={policy.support !== 'toggle'} onChange={toggleThinking} />
            <span className="switch-track"><span /></span>
          </label>
        </div>
        <div className="model-budget"><span>本次请求自动上限</span><strong>{policy.maxTokens} tokens</strong><small>{policy.thinking ? '包含思考过程的额度' : '优先保留给最终答案'}</small></div>
        <form className="model-form" onSubmit={onSave}>
          <label>模型供应商<select value={config.provider} onChange={(e) => setConfig({ ...config, provider: e.target.value })}><option>OpenAI-compatible</option><option>DeepSeek</option><option>通义千问 Qwen</option><option>智谱 GLM</option><option>自定义供应商</option></select></label>
          <label>模型名称<input value={config.model} onChange={(e) => setConfig({ ...config, model: e.target.value })} placeholder="例如：deepseek-v4-pro" /></label>
          <label className="full-field">接口地址（Base URL）<input value={config.baseUrl} onChange={(e) => setConfig({ ...config, baseUrl: e.target.value })} placeholder="例如：https://api.example.com/v1" /></label>
          <label className="full-field">API Key<div className="key-input"><input type={keyVisible ? 'text' : 'password'} value={config.apiKey} onChange={(e) => setConfig({ ...config, apiKey: e.target.value })} placeholder="sk-…" autoComplete="off" /><button type="button" onClick={() => setKeyVisible(!keyVisible)}>{keyVisible ? '隐藏' : '显示'}</button></div></label>
          <div className="model-actions"><button className="primary-button" type="submit">保存并启用 <span>→</span></button><button className="text-button" type="button" onClick={onClear}>清除本机配置</button></div>
        </form>
      </section>
      <section className="panel"><div className="section-heading"><div><span className="card-kicker">SECURITY NOTE</span><h3>使用说明</h3></div></div><div className="security-list"><div><span>01</span><p>首版仅将配置保存在当前浏览器，不会上传到项目服务器。</p></div><div><span>02</span><p>不要在公共电脑或演示结束后保留真实 API Key，使用完成后可以点击“清除本机配置”。</p></div><div><span>03</span><p>更换模型名称后，系统会自动重新识别模型能力、思考模式和输出上限。</p></div></div></section>
    </div>
  )
}

function Overview({ profile, topics, weakestTopic, imported, academicNews, academicLoading, academicError, onRefreshAcademic, onImport, onNavigate, onComplete }) {
  return (
    <div className="content-grid">
      <section className="hero-card">
        <div className="hero-copy">
          <span className="card-kicker">本周学习目标</span>
          <h2>{profile.goal}</h2>
          <p>根据你的学习画像，先从「审计抽样」入手，完成基础概念巩固和一道案例训练。</p>
          <button className="primary-button" onClick={() => onNavigate('case')}>开始今日训练 <span>→</span></button>
        </div>
        <div className="progress-orbit"><div><strong>62%</strong><span>本周进度</span></div></div>
        <div className="hero-pattern" />
      </section>

      <section className="stat-row">
        <Stat label="知识点掌握" value="68%" change="较上周 +6%" positive />
        <Stat label="累计学习时长" value="3.2h" change="本周目标 4h" />
        <Stat label="待巩固知识点" value={topics.filter((t) => t.value < 60).length} change="需要优先处理" />
      </section>

      <section className="panel academic-panel">
        <div className="section-heading">
          <div><span className="card-kicker">ACADEMIC DESK</span><h3>教务动态</h3></div>
          <div className="academic-heading-actions"><span className="status-pill live">● 实时速览</span><button className="text-button" onClick={onRefreshAcademic}>刷新</button></div>
        </div>
        {academicLoading && <div className="academic-state"><span className="loading-dot" />正在读取教务在线最新通知…</div>}
        {!academicLoading && academicError && <div className="academic-state error"><strong>暂时无法读取</strong><span>{academicError}</span><button className="secondary-button" onClick={onRefreshAcademic}>重试</button></div>}
        {!academicLoading && !academicError && !academicNews.length && <div className="academic-state"><span>暂无可展示的新内容</span><a href="https://jw.nau.edu.cn/" target="_blank" rel="noreferrer">打开教务在线 →</a></div>}
        {!academicLoading && !academicError && academicNews.length > 0 && <div className="academic-list">{academicNews.slice(0, 6).map((item) => <a className="academic-item" key={item.url} href={item.url} target="_blank" rel="noreferrer"><span className="academic-date">{item.date || '最新'}</span><span className="academic-title"><strong>{item.title}</strong><small>{item.category || '教务通知'}</small></span><span className="academic-arrow">↗</span></a>)}</div>}
        <div className="academic-footer"><span>内容来自南京审计大学教务在线</span><a href="https://jw.nau.edu.cn/" target="_blank" rel="noreferrer">查看全部通知 →</a></div>
      </section>

      <section className="panel knowledge-panel">
        <div className="section-heading"><div><span className="card-kicker">KNOWLEDGE MAP</span><h3>知识掌握度</h3></div><button className="text-button" onClick={() => onNavigate('portrait')}>查看完整画像 →</button></div>
        <div className="topic-list">
          {topics.map((topic) => <TopicBar key={topic.name} {...topic} />)}
        </div>
      </section>

      <section className="panel import-panel">
        <div className="section-heading"><div><span className="card-kicker">LEARNING DATA</span><h3>接入学习通记录</h3></div><span className="status-pill">{imported ? '已更新' : '演示模式'}</span></div>
        <div className="import-content">
          <div className="upload-icon">↥</div>
          <div><strong>{imported ? '学习记录已导入' : '上传错题记录，生成更准确的画像'}</strong><p>{imported ? '系统已根据错题情况调整你的推荐内容。' : '支持 CSV、Excel、错题截图或 PDF，首版不会读取学习通账号密码。'}</p></div>
          <button className="secondary-button" onClick={onImport}>{imported ? '再次导入' : '选择文件'}</button>
        </div>
      </section>

      <section className="panel today-panel">
        <div className="section-heading"><div><span className="card-kicker">TODAY</span><h3>今日推荐</h3></div><span className="time-badge">约 35 分钟</span></div>
        <div className="recommendation"><div className="recommend-icon teal">▣</div><div className="recommend-copy"><strong>审计抽样：从抽样单元到样本量</strong><span>基础巩固 · 预计 15 分钟</span></div><button className="round-arrow" onClick={() => onNavigate('qa')}>→</button></div>
        <div className="recommendation"><div className="recommend-icon orange">◇</div><div className="recommend-copy"><strong>案例训练：存货余额异常增长</strong><span>风险识别 · 预计 20 分钟</span></div><button className="round-arrow" onClick={() => onNavigate('case')}>→</button></div>
        <button className="complete-button" onClick={onComplete}>完成今日训练</button>
      </section>
    </div>
  )
}

function Stat({ label, value, change, positive }) {
  return <div className="stat-card"><span>{label}</span><strong>{value}</strong><small className={positive ? 'positive' : ''}>{positive && '↗ '}{change}</small></div>
}

function TopicBar({ name, value, tone }) {
  return <div className="topic-row"><div className="topic-label"><span className={`topic-dot ${tone}`} />{name}<em>{value < 60 ? '待巩固' : value > 80 ? '熟练' : '进行中'}</em></div><div className="bar-track"><div className={`bar-fill ${tone}`} style={{ width: `${value}%` }} /></div><strong>{value}%</strong></div>
}

function Portrait({ profile, setProfile, onSave, topics }) {
  return <div className="single-column"><section className="panel portrait-card"><div className="section-heading"><div><span className="card-kicker">LEARNING PORTRAIT</span><h3>我的学习画像</h3></div><span className="status-pill">随学习动态更新</span></div><form className="profile-form" onSubmit={onSave}><label>昵称<input value={profile.name} onChange={(e) => setProfile({ ...profile, name: e.target.value })} /></label><label>年级<select value={profile.grade} onChange={(e) => setProfile({ ...profile, grade: e.target.value })}><option>大一</option><option>大二</option><option>大三</option><option>大四</option><option>研究生</option></select></label><label>专业<input value={profile.major} onChange={(e) => setProfile({ ...profile, major: e.target.value })} /></label><label>学习目标<input value={profile.goal} onChange={(e) => setProfile({ ...profile, goal: e.target.value })} /></label><label>每周可学习时间<input type="number" min="1" max="30" value={profile.weeklyHours} onChange={(e) => setProfile({ ...profile, weeklyHours: e.target.value })} /></label><button className="primary-button" type="submit">保存画像 <span>→</span></button></form></section><section className="panel"><div className="section-heading"><div><span className="card-kicker">INSIGHT</span><h3>系统判断</h3></div></div><div className="insight-box"><span>✦</span><p>你当前最需要巩固的是<strong>{topics.find((t) => t.name === '审计抽样')?.name}</strong>和<strong>{topics.find((t) => t.name === '数据分析')?.name}</strong>。结合你的目标，建议采用“概念讲解 → 案例拆解 → 独立作答”的学习方式。</p></div></section></div>
}

function Qa({ chat, draft, setDraft, onSend, loading, onNewConversation }) {
  return (
    <div className="single-column">
      <section className="panel chat-panel">
        <div className="section-heading">
          <div><span className="card-kicker">AI TUTOR</span><h3>智能答疑</h3></div>
          <div className="section-heading-actions"><span className="status-pill live">● 真实模型 · 自动保存</span><button className="new-conversation-button" onClick={onNewConversation}>新建对话</button></div>
        </div>
        <div className="chat-window">{chat.map((item, index) => <div key={index} className={`chat-message ${item.from}`}><div className="chat-avatar">{item.from === 'bot' ? '审' : '林'}</div><div className={`message-bubble ${item.error ? 'error-message' : ''}`}><MarkdownMessage text={item.text} /></div></div>)}{loading && <div className="chat-message bot"><div className="chat-avatar">审</div><div className="message-bubble typing"><span /> <span /> <span /> 正在思考…</div></div>}</div>
        <div className="quick-prompts"><button disabled={loading} onClick={() => onSend('什么是审计抽样？')}>什么是审计抽样？</button><button disabled={loading} onClick={() => onSend('帮我分析一个存货审计案例')}>分析存货案例</button><button disabled={loading} onClick={() => onSend('根据我的薄弱点安排练习')}>安排个性化练习</button></div>
        <div className="chat-input"><input disabled={loading} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && onSend()} placeholder={loading ? '模型正在生成回答…' : '输入你想学习的内容…'} /><button disabled={loading} onClick={() => onSend()}>{loading ? '生成中…' : '发送 ↑'}</button></div>
      </section>
    </div>
  )
}

function LegacyQa({ chat, draft, setDraft, onSend, loading }) {
  return <div className="single-column"><section className="panel chat-panel"><div className="section-heading"><div><span className="card-kicker">AI TUTOR</span><h3>智能答疑</h3></div><span className="status-pill live">● 真实模型</span></div><div className="chat-window">{chat.map((item, index) => <div key={index} className={`chat-message ${item.from}`}><div className="chat-avatar">{item.from === 'bot' ? '审' : '林'}</div><div className={`message-bubble ${item.error ? 'error-message' : ''}`}><MarkdownMessage text={item.text} /></div></div>)}{loading && <div className="chat-message bot"><div className="chat-avatar">审</div><div className="message-bubble typing"><span /> <span /> <span /> 正在思考…</div></div>}</div><div className="quick-prompts"><button disabled={loading} onClick={() => onSend('什么是审计抽样？')}>什么是审计抽样？</button><button disabled={loading} onClick={() => onSend('帮我分析一个存货审计案例')}>分析存货案例</button><button disabled={loading} onClick={() => onSend('根据我的薄弱点安排练习')}>安排个性化练习</button></div><div className="chat-input"><input disabled={loading} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && onSend()} placeholder={loading ? '模型正在生成回答…' : '输入你想学习的内容…'} /><button disabled={loading} onClick={() => onSend()}>{loading ? '生成中…' : '发送 ↑'}</button></div></section></div>
}

function MarkdownMessage({ text }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
}

function CaseTraining({ onReview, loading, result, initialAnswers, practiceRounds = [], onNewConversation, onFollowUp, followUpLoading, followUpResult, onNextPractice, nextPracticeLoading, nextPracticeResult }) {
  const [riskAnswer, setRiskAnswer] = useState('')
  const [evidenceAnswer, setEvidenceAnswer] = useState('')
  const [formError, setFormError] = useState('')
  const [followUpOpen, setFollowUpOpen] = useState(false)
  const [followUpDraft, setFollowUpDraft] = useState('')
  const [nextPracticeOpen, setNextPracticeOpen] = useState(false)
  const [nextPracticeDraft, setNextPracticeDraft] = useState('')

  useEffect(() => {
    if (!initialAnswers) {
      setRiskAnswer('')
      setEvidenceAnswer('')
      setNextPracticeDraft('')
      return
    }
    setRiskAnswer(initialAnswers.riskAnswer || '')
    setEvidenceAnswer(initialAnswers.evidenceAnswer || '')
    setNextPracticeDraft(initialAnswers.nextPracticeAnswer || '')
  }, [initialAnswers])

  const currentPracticeQuestion = practiceRounds.at(-1)?.nextQuestion || result?.nextPractice || '结合本案例，审计师下一步应如何验证管理层“市场需求即将回升”的解释？'

  function submitCase() {
    if (!riskAnswer.trim() && !evidenceAnswer.trim()) {
      setFormError('请至少填写一项判断，再提交 AI 点评')
      return
    }
    setFormError('')
    setFollowUpOpen(false)
    setNextPracticeOpen(false)
    setFollowUpDraft('')
    setNextPracticeDraft('')
    onReview({ riskAnswer, evidenceAnswer })
  }

  function submitFollowUp() {
    if (!followUpDraft.trim()) return
    onFollowUp(followUpDraft)
  }

  function submitNextPractice() {
    if (!nextPracticeDraft.trim()) return
    onNextPractice({
      question: currentPracticeQuestion,
      answer: nextPracticeDraft,
    })
    setNextPracticeDraft('')
  }

  return (
    <div className="single-column">
      <section className="panel case-card">
        <div className="case-header">
          <div><span className="card-kicker">CASE LAB · 01</span><h3>存货余额异常增长</h3><p>根据案例信息识别审计风险，并设计后续审计程序。</p></div>
          <span className="difficulty">基础 · 15分钟</span>
        </div>
        <div className="case-body">
          <div className="case-situation"><span>案例背景</span><p>华东制造公司本年度存货余额较上年增长 48%，但销售收入仅增长 6%。期末仓库中有部分产品积压超过 18 个月，管理层解释为“市场需求即将回升”。</p></div>
          <label className="case-question"><span>第一步 · 你认为最需要关注的风险是什么？</span><textarea value={riskAnswer} onChange={(event) => setRiskAnswer(event.target.value)} placeholder="输入你的判断，例如：可能存在存货跌价或存货数量虚增风险…" /></label>
          <label className="case-question"><span>第二步 · 你会优先获取哪些审计证据？</span><textarea value={evidenceAnswer} onChange={(event) => setEvidenceAnswer(event.target.value)} placeholder="从盘点记录、销售合同、期后销售等角度思考…" /></label>
          {formError && <p className="case-form-error">{formError}</p>}
        </div>
        <div className="case-footer">
          <button className="secondary-button" onClick={submitCase} disabled={loading}>{loading ? 'AI 正在点评…' : '提交并获得 AI 点评'}</button>
          <button className="new-conversation-button" onClick={onNewConversation}>新建实训</button>
          <span className="case-helper">AI 完成点评、追问或练习反馈后会自动保存到对话库</span>
        </div>
        {loading && <div className="case-review pending"><span className="loading-dot" />AI 正在分析你的风险判断和审计证据…</div>}
        {!loading && result?.error && <div className="case-review error"><strong>点评没有生成</strong><p>{result.error}</p></div>}
        {!loading && result?.text && <>
          <div className="case-review"><div className="case-review-heading"><strong>AI 案例点评</strong><span>已结合当前学习画像</span></div><MarkdownMessage text={result.reviewText || result.text} /></div>
          <div className="case-actions" aria-label="案例点评后的操作">
              <button className={`case-action-card ${followUpOpen ? 'selected' : ''}`} onClick={() => { setFollowUpOpen((open) => !open); setNextPracticeOpen(false) }}>
              <span className="case-action-icon">↗</span><span><strong>继续追问</strong><small>针对点评中的疑点继续问 AI</small></span><em>{followUpOpen ? '收起' : '展开'}</em>
            </button>
            <button className={`case-action-card ${nextPracticeOpen ? 'selected' : ''}`} onClick={() => { setNextPracticeOpen((open) => !open); setFollowUpOpen(false) }}>
              <span className="case-action-icon orange">✓</span><span><strong>开始下一步练习</strong><small>回答 AI 点出的追问并获得反馈</small></span><em>{nextPracticeOpen ? '收起' : '开始'}</em>
            </button>
          </div>
          {followUpOpen && <div className="case-interaction-panel">
            <div className="case-interaction-heading"><strong>继续追问</strong><span>不确定的地方可以直接问</span></div>
            <div className="case-interaction-input"><input value={followUpDraft} onChange={(event) => setFollowUpDraft(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && submitFollowUp()} placeholder="例如：为什么还要检查期后销售？" disabled={followUpLoading} /><button onClick={submitFollowUp} disabled={followUpLoading || !followUpDraft.trim()}>{followUpLoading ? '回答中…' : '发送'}</button></div>
            {followUpLoading && <div className="case-inline-loading"><span className="loading-dot" />AI 正在回答你的追问…</div>}
            {!followUpLoading && followUpResult?.error && <div className="case-inline-error">{followUpResult.error}</div>}
            {!followUpLoading && followUpResult?.text && <div className="case-follow-up-answer"><MarkdownMessage text={followUpResult.text} /></div>}
          </div>}
          {nextPracticeOpen && <div className="case-interaction-panel practice-panel">
            <div className="case-interaction-heading"><strong>{practiceRounds.length ? `下一轮练习 · 第 ${practiceRounds.length + 1} 轮` : '下一步练习'}</strong><span>每次批改后都会生成新的练习</span></div>
            {practiceRounds.map((round, index) => <div className="practice-round" key={`${round.question}-${index}`}><div className="practice-round-label">第 {index + 1} 轮 · 已完成</div><div className="practice-question">{round.question}</div><div className="practice-answer"><strong>你的回答</strong><p>{round.answer}</p></div><div className="case-follow-up-answer"><MarkdownMessage text={round.feedback?.reviewText || round.feedback?.text || ''} /></div></div>)}
            <div className="practice-question">{currentPracticeQuestion}</div>
            <textarea value={nextPracticeDraft} onChange={(event) => setNextPracticeDraft(event.target.value)} placeholder="写下你的审计判断、拟获取的证据或具体程序…" disabled={nextPracticeLoading} />
            <div className="practice-submit-row"><span>建议写出判断依据和下一步审计程序</span><button className="secondary-button" onClick={submitNextPractice} disabled={nextPracticeLoading || !nextPracticeDraft.trim()}>{nextPracticeLoading ? 'AI 批改中…' : '提交练习答案'}</button></div>
            {nextPracticeLoading && <div className="case-inline-loading"><span className="loading-dot" />AI 正在批改下一步练习…</div>}
            {!nextPracticeLoading && nextPracticeResult?.error && <div className="case-inline-error">{nextPracticeResult.error}</div>}
            {!nextPracticeLoading && nextPracticeResult?.text && <div className="case-follow-up-answer"><MarkdownMessage text={nextPracticeResult.text} /></div>}
          </div>}
        </>}
      </section>
    </div>
  )
}

function LegacyCaseTraining({ onComplete }) {
  return <div className="single-column"><section className="panel case-card"><div className="case-header"><div><span className="card-kicker">CASE LAB · 01</span><h3>存货余额异常增长</h3><p>根据案例信息识别审计风险，并设计后续审计程序。</p></div><span className="difficulty">基础 · 15分钟</span></div><div className="case-body"><div className="case-situation"><span>案例背景</span><p>华东制造公司本年度存货余额较上年增长 48%，但销售收入仅增长 6%。期末仓库中有部分产品积压超过 18 个月，管理层解释为“市场需求即将回升”。</p></div><div className="case-question"><span>第一步 · 你认为最需要关注的风险是什么？</span><textarea placeholder="输入你的判断，例如：可能存在存货跌价或存货数量虚增风险…" /></div><div className="case-question"><span>第二步 · 你会优先获取哪些审计证据？</span><textarea placeholder="从盘点记录、销售合同、期后销售等角度思考…" /></div></div><div className="case-footer"><button className="secondary-button" onClick={() => onComplete()}>提交并获得 AI 点评</button><button className="text-button">查看提示</button></div></section></div>
}

function ConversationLibrary({ conversations, loading, error, onRefresh, onOpen, onDelete }) {
  function formatTime(value) {
    if (!value) return '未记录时间'
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? '未记录时间' : date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  }

  function getPreview(item) {
    if (item.type === 'qa') {
      const messages = item.payload?.chat || []
      return messages.at(-1)?.text || '还没有可展示的对话内容'
    }
    return item.payload?.riskAnswer || item.payload?.nextPracticeAnswer || '已保存案例背景，可继续完善作答'
  }

  return (
    <div className="single-column">
      <section className="panel conversation-library">
        <div className="section-heading">
          <div><span className="card-kicker">CONVERSATION LIBRARY</span><h3>对话库</h3></div>
          <div className="library-heading-actions"><span className="status-pill">服务端文件存储</span><button className="text-button" onClick={onRefresh}>刷新</button></div>
        </div>
        <p className="library-lead">保存过的智能答疑和案例实训会放在这里。打开后可以继续提问、补充作答或重新获得 AI 反馈。</p>
        {loading && <div className="library-state"><span className="loading-dot" />正在读取历史对话…</div>}
        {!loading && error && <div className="library-state error"><strong>读取失败</strong><span>{error}</span><button className="secondary-button" onClick={onRefresh}>重试</button></div>}
        {!loading && !error && !conversations.length && <div className="library-empty"><div className="library-empty-icon">▤</div><strong>还没有保存的对话</strong><p>在智能答疑或案例实训中完成一次 AI 互动后，记录会自动出现在这里。</p></div>}
        {!loading && !error && conversations.length > 0 && <div className="conversation-list">{conversations.map((item) => <article className="conversation-item" key={item.id}>
          <div className={`conversation-type ${item.type === 'case' ? 'case' : 'qa'}`}>{item.type === 'case' ? '▣' : '✦'}</div>
          <div className="conversation-copy"><div className="conversation-meta"><span>{item.type === 'case' ? '案例实训' : '智能答疑'}</span><time>{formatTime(item.updatedAt || item.createdAt)}</time></div><strong>{item.title}</strong><p>{getPreview(item)}</p></div>
          <div className="conversation-actions"><button className="save-button" onClick={() => onOpen(item)}>继续</button><button className="delete-button" onClick={() => window.confirm('确定删除这条历史对话吗？') && onDelete(item.id)} aria-label={`删除${item.title}`}>删除</button></div>
        </article>)}</div>}
      </section>
    </div>
  )
}

function ConversationDialog({ item, onClose, onContinue }) {
  const payload = item?.payload || {}
  const chat = Array.isArray(payload.chat) ? payload.chat : []
  const reviewText = payload.review?.reviewText || payload.review?.text || ''
  const followUpText = payload.followUpResult?.text || ''
  const nextPracticeText = payload.nextPracticeResult?.text || ''
  const practiceRounds = Array.isArray(payload.practiceRounds) ? payload.practiceRounds : []

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') onClose()
    }
    document.body.classList.add('dialog-open')
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      document.body.classList.remove('dialog-open')
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [onClose])

  return (
    <div className="conversation-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section className="conversation-dialog" role="dialog" aria-modal="true" aria-labelledby="conversation-dialog-title">
        <header className="conversation-dialog-header">
          <div className="conversation-dialog-heading">
            <span className={`conversation-dialog-type ${item.type === 'case' ? 'case' : ''}`}>{item.type === 'case' ? '案例实训' : '智能答疑'}</span>
            <h2 id="conversation-dialog-title">{item.title || '对话详情'}</h2>
            <p>{item.type === 'case' ? '查看案例作答、AI 点评与练习进度' : '查看完整对话记录与 Markdown 内容'}</p>
          </div>
          <button className="dialog-close-button" type="button" onClick={onClose} aria-label="关闭对话框">×</button>
        </header>

        <div className="conversation-dialog-scroll">
          {item.type === 'qa' && <div className="conversation-dialog-chat-list">
            {chat.length ? chat.map((message, index) => <article className={`conversation-dialog-message ${message.from === 'user' ? 'user' : 'bot'} ${message.error ? 'error' : ''}`} key={`${message.from}-${index}`}>
              <div className="conversation-dialog-message-meta">{message.from === 'user' ? '你' : '审智学伴'}</div>
              <div className="message-bubble conversation-dialog-message-bubble"><MarkdownMessage text={message.text} /></div>
            </article>) : <div className="conversation-dialog-empty">这段对话暂时没有可展示的内容。</div>}
          </div>}

          {item.type === 'case' && <div className="conversation-dialog-case">
            <div className="conversation-dialog-section">
              <span className="conversation-dialog-section-label">案例作答</span>
              <div className="conversation-dialog-answer-grid">
                <div><strong>风险判断</strong><p>{payload.riskAnswer || '未填写'}</p></div>
                <div><strong>审计证据</strong><p>{payload.evidenceAnswer || '未填写'}</p></div>
              </div>
            </div>
            {reviewText && <div className="conversation-dialog-rich-card"><strong>AI 点评</strong><MarkdownMessage text={reviewText} /></div>}
            {followUpText && <div className="conversation-dialog-rich-card"><strong>追问反馈</strong><MarkdownMessage text={followUpText} /></div>}
            {practiceRounds.map((round, index) => <div className="conversation-dialog-rich-card" key={`${round.question}-${index}`}><strong>第 {index + 1} 轮练习</strong><p className="conversation-dialog-question">{round.question}</p><p><b>你的回答：</b>{round.answer}</p><MarkdownMessage text={round.feedback?.reviewText || round.feedback?.text || ''} /></div>)}
            {nextPracticeText && <div className="conversation-dialog-rich-card"><strong>下一步练习</strong><MarkdownMessage text={nextPracticeText} /></div>}
          </div>}
        </div>

        <footer className="conversation-dialog-footer">
          <span>历史内容已从服务端文件中读取</span>
          <div><button className="text-button" type="button" onClick={onClose}>关闭</button><button className="save-button" type="button" onClick={() => onContinue(item)}>编辑并继续</button></div>
        </footer>
      </section>
    </div>
  )
}

function InteractiveConversationDialog({ item, onClose, onAskQa, onAskCase, onSaveQa, onSaveCase }) {
  const [editing, setEditing] = useState(false)
  const [dialogChat, setDialogChat] = useState(() => Array.isArray(item?.payload?.chat) ? item.payload.chat : [])
  const [caseDialogue, setCaseDialogue] = useState(() => Array.isArray(item?.payload?.dialogue) ? item.payload.dialogue : [])
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [currentItem, setCurrentItem] = useState(item)

  useEffect(() => {
    setCurrentItem(item)
    setDialogChat(Array.isArray(item?.payload?.chat) ? item.payload.chat : [])
    setCaseDialogue(Array.isArray(item?.payload?.dialogue) ? item.payload.dialogue : [])
    setDraft('')
    setError('')
    setEditing(false)
  }, [item?.id])

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') onClose()
    }
    document.body.classList.add('dialog-open')
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      document.body.classList.remove('dialog-open')
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [onClose])

  const payload = currentItem?.payload || {}
  const snapshot = payload.case || caseStudy
  const questions = Array.isArray(snapshot.questions) ? snapshot.questions : caseStudy.questions
  const reviewText = payload.review?.reviewText || payload.review?.text || ''
  const followUpText = payload.followUpResult?.text || ''
  const nextPracticeText = payload.nextPracticeResult?.text || ''
  const practiceRounds = Array.isArray(payload.practiceRounds) ? payload.practiceRounds : []

  async function submitMessage(event) {
    event.preventDefault()
    const text = draft.trim()
    if (!text || loading || !editing) return
    setDraft('')
    setError('')
    setLoading(true)
    const previousMessages = currentItem.type === 'qa' ? dialogChat : caseDialogue
    const userMessage = { from: 'user', text }
    const pendingMessages = [...previousMessages, userMessage]
    if (currentItem.type === 'qa') setDialogChat(pendingMessages)
    else setCaseDialogue(pendingMessages)

    try {
      const answer = currentItem.type === 'qa'
        ? await onAskQa(previousMessages, text)
        : await onAskCase(currentItem, previousMessages, text)
      const nextMessages = [...pendingMessages, { from: 'bot', text: answer }]
      if (currentItem.type === 'qa') {
        setDialogChat(nextMessages)
        const saved = await onSaveQa({ id: currentItem.id, chat: nextMessages })
        if (saved) setCurrentItem(saved)
        else setError('回答已显示，但本次更新暂未保存到服务端。')
      } else {
        setCaseDialogue(nextMessages)
        const nextPayload = { ...payload, case: payload.case || caseStudy, dialogue: nextMessages }
        const saved = await onSaveCase({ id: currentItem.id, title: currentItem.title, payload: nextPayload })
        if (saved) setCurrentItem(saved)
        else setError('回答已显示，但本次更新暂未保存到服务端。')
      }
    } catch (requestError) {
      const message = requestError?.message || '无法连接模型服务'
      const failedMessage = { from: 'bot', error: true, text: `这次请求没有成功：${message}` }
      if (currentItem.type === 'qa') setDialogChat((current) => [...current, failedMessage])
      else setCaseDialogue((current) => [...current, failedMessage])
      setError(message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="conversation-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section className={`conversation-dialog conversation-dialog-interactive ${editing ? 'editing' : ''}`} role="dialog" aria-modal="true" aria-labelledby="interactive-conversation-title">
        <header className="conversation-dialog-header">
          <div className="conversation-dialog-heading">
            <span className={`conversation-dialog-type ${currentItem.type === 'case' ? 'case' : ''}`}>{currentItem.type === 'case' ? '案例实训' : '智能答疑'}</span>
            <h2 id="interactive-conversation-title">{currentItem.title || '对话详情'}</h2>
            <p>{editing ? '已进入当前线程，可直接继续发送消息' : '历史内容预览，点击编辑并继续后可在此对话'}</p>
          </div>
          <button className="dialog-close-button" type="button" onClick={onClose} aria-label="关闭对话框">×</button>
        </header>

        <div className="conversation-dialog-scroll">
          {currentItem.type === 'qa' && <div className="conversation-dialog-chat-list">
            {dialogChat.length ? dialogChat.map((message, index) => <article className={`conversation-dialog-message ${message.from === 'user' ? 'user' : 'bot'} ${message.error ? 'error' : ''}`} key={`${message.from}-${index}`}>
              <div className="conversation-dialog-message-meta">{message.from === 'user' ? '你' : '审智学伴'}</div>
              <div className="message-bubble conversation-dialog-message-bubble"><MarkdownMessage text={message.text} /></div>
            </article>) : <div className="conversation-dialog-empty">这段对话暂时没有可展示的内容。</div>}
          </div>}

          {currentItem.type === 'case' && <div className="conversation-dialog-case">
            <div className="conversation-dialog-section case-snapshot-card">
              <span className="conversation-dialog-section-label">完整案例</span>
              <h3>{snapshot.title}</h3>
              <p>{snapshot.background}</p>
              <ol>{questions.map((question, index) => <li key={`${question}-${index}`}>{question}</li>)}</ol>
              <small>{snapshot.instruction}</small>
            </div>
            <div className="conversation-dialog-section">
              <span className="conversation-dialog-section-label">案例作答</span>
              <div className="conversation-dialog-answer-grid">
                <div><strong>风险判断</strong><p>{payload.riskAnswer || '未填写'}</p></div>
                <div><strong>审计证据</strong><p>{payload.evidenceAnswer || '未填写'}</p></div>
              </div>
            </div>
            {reviewText && <div className="conversation-dialog-rich-card"><strong>AI 点评</strong><MarkdownMessage text={reviewText} /></div>}
            {followUpText && <div className="conversation-dialog-rich-card"><strong>追问反馈</strong><MarkdownMessage text={followUpText} /></div>}
            {practiceRounds.map((round, index) => <div className="conversation-dialog-rich-card" key={`${round.question}-${index}`}><strong>第 {index + 1} 轮练习</strong><p className="conversation-dialog-question">{round.question}</p><p><b>你的回答：</b>{round.answer}</p><MarkdownMessage text={round.feedback?.reviewText || round.feedback?.text || ''} /></div>)}
            {nextPracticeText && <div className="conversation-dialog-rich-card"><strong>下一步练习</strong><MarkdownMessage text={nextPracticeText} /></div>}
            {caseDialogue.length > 0 && <div className="conversation-dialog-chat-list conversation-dialog-case-thread">{caseDialogue.map((message, index) => <article className={`conversation-dialog-message ${message.from === 'user' ? 'user' : 'bot'} ${message.error ? 'error' : ''}`} key={`${message.from}-${index}`}><div className="conversation-dialog-message-meta">{message.from === 'user' ? '你' : '审智学伴'}</div><div className="message-bubble conversation-dialog-message-bubble"><MarkdownMessage text={message.text} /></div></article>)}</div>}
          </div>}
          {error && <div className="conversation-dialog-error">{error}</div>}
        </div>

        {editing && <form className="conversation-dialog-composer" onSubmit={submitMessage}>
          <input value={draft} onChange={(event) => setDraft(event.target.value)} disabled={loading} placeholder={currentItem.type === 'case' ? '继续追问这个案例，例如：还需要验证哪些数据？' : '继续输入你想问的问题…'} aria-label="继续输入消息" />
          <button type="submit" disabled={loading || !draft.trim()}>{loading ? '发送中…' : '发送'}</button>
        </form>}
        <footer className="conversation-dialog-footer">
          <span>{editing ? '新消息会自动追加并保存到当前线程' : '历史内容已从服务端文件中读取'}</span>
          <div><button className="text-button" type="button" onClick={onClose}>关闭</button>{!editing && <button className="save-button" type="button" onClick={() => setEditing(true)}>编辑并继续</button>}</div>
        </footer>
      </section>
    </div>
  )
}

function Tasks({ onNavigate, onComplete }) {
  return (
    <div className="single-column">
      <section className="panel tasks-page">
        <div className="section-heading">
          <div><span className="card-kicker">LEARNING TASKS</span><h3>学习任务</h3></div>
          <span className="time-badge">本周 4 小时</span>
        </div>
        <p className="tasks-lead">把今天的学习拆成几个清晰的小步骤，完成后系统会同步更新你的学习画像。</p>
        <div className="task-list">
          <button className="task-card" onClick={() => onNavigate('qa')}>
            <span className="task-symbol">01</span>
            <span className="task-copy"><strong>复习：审计抽样基础概念</strong><small>智能答疑 · 15 分钟</small></span>
            <span className="task-arrow">→</span>
          </button>
          <button className="task-card" onClick={() => onNavigate('case')}>
            <span className="task-symbol orange">02</span>
            <span className="task-copy"><strong>案例训练：存货余额异常增长</strong><small>风险识别 · 20 分钟 · AI 点评</small></span>
            <span className="task-arrow">→</span>
          </button>
          <button className="task-card" onClick={() => onNavigate('plan')}>
            <span className="task-symbol green">03</span>
            <span className="task-copy"><strong>查看本周学习计划</strong><small>进度复盘 · 10 分钟</small></span>
            <span className="task-arrow">→</span>
          </button>
          <button className="task-card task-card-complete" onClick={onComplete}>
            <span className="task-symbol purple">✓</span>
            <span className="task-copy"><strong>完成今日学习打卡</strong><small>更新审计抽样掌握度</small></span>
            <span className="task-arrow">完成</span>
          </button>
        </div>
      </section>
    </div>
  )
}

function Plan({ topics, onNavigate, onComplete }) {
  return <div className="single-column"><section className="panel plan-card"><div className="section-heading"><div><span className="card-kicker">WEEKLY PLAN</span><h3>本周学习计划</h3></div><span className="time-badge">4小时目标</span></div><div className="plan-progress"><div><strong>2.5h</strong><span>已完成</span></div><div className="plan-track"><div style={{ width: '62%' }} /></div><strong>62%</strong></div><div className="plan-list"><PlanItem index="01" title="复习：审计抽样基础概念" meta="知识巩固 · 15分钟" done /><PlanItem index="02" title="案例：存货余额异常增长" meta="风险识别 · 20分钟" onClick={() => onNavigate('case')} /><PlanItem index="03" title="练习：抽样风险判断" meta="错题强化 · 15分钟" onClick={onComplete} /><PlanItem index="04" title="复盘：本周薄弱知识点" meta={`重点：${topics.filter((t) => t.value < 60).map((t) => t.name).join('、')}`} /></div></section></div>
}

function PlanItem({ index, title, meta, done, onClick }) {
  return <button className={`plan-item ${done ? 'done' : ''}`} onClick={onClick}><span className="plan-index">{done ? '✓' : index}</span><span className="plan-copy"><strong>{title}</strong><small>{meta}</small></span><span className="plan-arrow">{done ? '已完成' : '→'}</span></button>
}

export default App
