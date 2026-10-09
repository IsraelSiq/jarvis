import { createToolRegistry } from './gemini-tools.mjs'
import { displayServer } from './panels.mjs'
import { uiServer } from './ui.mjs'
import { chromeServer } from './chrome.mjs'
import { visionServer } from './vision.mjs'

const MAX_TOOL_ROUNDS = 24
const MAX_HISTORY_TURNS = 12

function toolResultText(result) {
  const content = result?.content ?? []
  const text = content
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n')
  if (text) return text
  if (content.some((item) => item.type === 'image')) {
    return 'The tool returned image data, which this text-only model cannot inspect.'
  }
  return 'Completed.'
}

function parseArguments(value) {
  if (value && typeof value === 'object') return value
  if (typeof value !== 'string' || !value.trim()) return {}
  try {
    return JSON.parse(value)
  } catch {
    return {}
  }
}

async function readStream(response, onText) {
  if (!response.body) throw new Error('Ollama returned an empty response stream.')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const calls = new Map()
  let content = ''
  let buffer = ''

  const line = (raw) => {
    if (!raw.startsWith('data:')) return
    const data = raw.slice(5).trim()
    if (!data || data === '[DONE]') return
    let event
    try {
      event = JSON.parse(data)
    } catch {
      return
    }
    for (const choice of event.choices ?? []) {
      const delta = choice.delta ?? {}
      if (typeof delta.content === 'string' && delta.content) {
        content += delta.content
        onText(delta.content)
      }
      for (const part of delta.tool_calls ?? []) {
        const index = part.index ?? calls.size
        const call = calls.get(index) ?? {
          id: '',
          type: 'function',
          function: { name: '', arguments: '' },
        }
        if (part.id) call.id = part.id
        if (part.function?.name) call.function.name += part.function.name
        if (part.function?.arguments !== undefined) {
          const args = part.function.arguments
          call.function.arguments += typeof args === 'string' ? args : JSON.stringify(args)
        }
        calls.set(index, call)
      }
    }
  }

  while (true) {
    const { value, done } = await reader.read()
    buffer += decoder.decode(value, { stream: !done })
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''
    for (const raw of lines) line(raw)
    if (done) break
  }
  if (buffer) line(buffer)
  return { content, toolCalls: [...calls.values()] }
}

export async function runOllamaSession(socket, options) {
  const {
    model,
    systemPrompt,
    baseUrl,
    mcpServers,
    allowWrites,
    decideTool,
  } = options
  const waiting = new Map()
  let askSequence = 0
  let answering = null
  let controller = null
  let queue = Promise.resolve()
  let closed = false
  let completedTurns = 0
  let history = []

  const send = (message) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message))
  }
  const sendTurn = (message) => send({ ...message, ask: answering })
  const ask = (kind, args, timeoutMs = 20_000) =>
    new Promise((resolve, reject) => {
      if (socket.readyState !== socket.OPEN) {
        reject(new Error('the interface is not connected'))
        return
      }
      const id = `q${++askSequence}`
      const timer = setTimeout(() => {
        waiting.delete(id)
        reject(new Error('the interface did not answer in time'))
      }, timeoutMs)
      waiting.set(id, { resolve, reject, timer })
      send({ type: kind, id, ...args })
    })

  const toolRegistry = await createToolRegistry(mcpServers, {
    jarvis: displayServer(
      (panel) => send({ type: 'panel', panel }),
      (blade) => send({ type: 'blade', blade }),
    ),
    jarvis_ui: uiServer((op, args) => send({ type: 'ui', op, args })),
    jarvis_chrome: chromeServer({ allowWrites }),
    jarvis_eyes: visionServer(ask),
  })
  const toolMap = new Map(toolRegistry.declarations.map((definition) => [definition.name, definition]))
  const tools = toolRegistry.declarations.map((definition) => ({
    type: 'function',
    function: {
      name: definition.name,
      description: definition.description,
      parameters: definition.parametersJsonSchema ?? { type: 'object', properties: {} },
    },
  }))

  send({ type: 'ready', servers: toolRegistry.connected })
  console.log(`[jarvis] ${toolRegistry.connected.length} MCP servers available (Ollama)`)

  const runTurn = async (id, text) => {
    answering = id
    controller = new AbortController()
    const turnMessages = [{ role: 'user', content: text }]
    let turnText = ''

    try {
      for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
        const response = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: systemPrompt },
              ...history,
              ...turnMessages,
            ],
            tools,
            stream: true,
          }),
          signal: controller.signal,
        })
        if (!response.ok) {
          const detail = await response.text()
          throw new Error(`Ollama error (${response.status}): ${detail.slice(0, 500)}`)
        }

        const result = await readStream(response, (delta) => {
          turnText += delta
          sendTurn({ type: 'text', delta })
        })
        const toolCalls = result.toolCalls.filter((call) => call.function.name)
        if (!toolCalls.length) break
        if (round === MAX_TOOL_ROUNDS) {
          throw new Error('Ollama exceeded the maximum tool-call rounds.')
        }

        const assistantCalls = toolCalls.map((call, index) => ({
          ...call,
          id: call.id || `ollama-${round}-${index}`,
          function: {
            ...call.function,
            arguments: JSON.stringify(parseArguments(call.function.arguments)),
          },
        }))
        turnMessages.push({
          role: 'assistant',
          content: result.content || null,
          tool_calls: assistantCalls,
        })

        for (const call of assistantCalls) {
          const name = call.function.name
          const definition = toolMap.get(name)
          let result
          if (!definition) {
            result = { isError: true, content: [{ type: 'text', text: 'This tool is not available.' }] }
          } else if (!decideTool(name)) {
            result = {
              isError: true,
              content: [{ type: 'text', text: 'Blocked: JARVIS is running in read-only mode and cannot take actions that change anything.' }],
            }
          } else {
            if (name !== 'mcp__jarvis__display' && !name.startsWith('mcp__jarvis_ui__')) {
              sendTurn({ type: 'tool', name })
            }
            try {
              result = await toolRegistry.call(name, parseArguments(call.function.arguments))
            } catch (error) {
              result = { isError: true, content: [{ type: 'text', text: String(error?.message ?? error) }] }
            }
          }
          turnMessages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: toolResultText(result),
          })
        }
      }

      history.push(...turnMessages)
      completedTurns++
      if (completedTurns >= MAX_HISTORY_TURNS) {
        history = []
        completedTurns = 0
      }
      sendTurn({ type: 'done', text: turnText })
    } catch (error) {
      if (controller?.signal.aborted) {
        sendTurn({ type: 'done', text: turnText })
      } else {
        console.error('[jarvis] Ollama turn failed:', error)
        sendTurn({ type: 'error', message: String(error?.message ?? error) })
      }
    } finally {
      controller = null
      answering = null
    }
  }

  socket.on('message', (raw) => {
    let message
    try {
      message = JSON.parse(raw.toString())
    } catch {
      return
    }
    if (message.type === 'ask' && typeof message.text === 'string') {
      const id = typeof message.id === 'string' ? message.id : null
      queue = queue.then(() => runTurn(id, message.text)).catch((error) => {
        console.error('[jarvis] turn queue failed:', error)
      })
    } else if (message.type === 'interrupt') {
      controller?.abort()
    } else if (message.type === 'reply' && typeof message.id === 'string') {
      const slot = waiting.get(message.id)
      if (slot) {
        waiting.delete(message.id)
        clearTimeout(slot.timer)
        if (message.error) slot.reject(new Error(message.error))
        else slot.resolve(message)
      }
    }
  })

  socket.on('close', () => {
    closed = true
    controller?.abort()
    for (const slot of waiting.values()) {
      clearTimeout(slot.timer)
      slot.reject(new Error('the interface disconnected'))
    }
    waiting.clear()
    void toolRegistry.close()
  })
  socket.on('error', (error) => console.warn('[jarvis] websocket error:', error.message))

  return () => {
    if (!closed) socket.close()
  }
}