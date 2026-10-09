import { createToolRegistry } from './gemini-tools.mjs'
import { displayServer } from './panels.mjs'
import { uiServer } from './ui.mjs'
import { chromeServer } from './chrome.mjs'
import { visionServer } from './vision.mjs'

const MAX_TOOL_ROUNDS = 24
const MAX_HISTORY_TURNS = 12

function functionResult(result) {
  const parts = (result?.content ?? []).flatMap((item) => {
    if (item.type === 'text') return [{ type: 'text', text: item.text }]
    if (item.type === 'image' && item.data) {
      return [{
        type: 'image',
        mime_type: item.mimeType ?? item.mime_type ?? 'image/jpeg',
        data: item.data,
      }]
    }
    return []
  })
  return parts.length ? parts : 'Completed.'
}

export async function runGeminiSession(socket, options) {
  const {
    ai,
    model,
    systemPrompt,
    mcpServers,
    allowWrites,
    decideTool,
  } = options
  const waiting = new Map()
  let askSequence = 0
  let answering = null
  let controller = null
  let activeInteractionId = null
  let previousInteractionId = null
  let completedTurns = 0
  let queue = Promise.resolve()
  let closed = false

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
  const geminiTools = [
    { type: 'google_search' },
    ...toolRegistry.declarations.map((definition) => ({
      type: 'function',
      name: definition.name,
      description: definition.description,
      parameters: definition.parametersJsonSchema,
    })),
  ]
  send({ type: 'ready', servers: toolRegistry.connected })
  console.log(`[jarvis] ${toolRegistry.connected.length} MCP servers available`)

  const runTurn = async (id, text) => {
    answering = id
    controller = new AbortController()
    let turnText = ''
    let workingInteractionId = previousInteractionId
    let nextInput = text
    activeInteractionId = null

    try {
      if (!ai) throw new Error('GEMINI_API_KEY is not configured for bridge mode.')
      for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
        const stream = await ai.interactions.create(
          {
            model,
            input: nextInput,
            system_instruction: systemPrompt,
            tools: geminiTools,
            generation_config: { max_output_tokens: 4096, tool_choice: 'validated' },
            store: true,
            stream: true,
            ...(workingInteractionId
              ? { previous_interaction_id: workingInteractionId }
              : {}),
          },
          { signal: controller.signal },
        )
        let interaction = null
        const calls = new Map()

        for await (const event of stream) {
          if (event.event_type === 'interaction.created') {
            activeInteractionId = event.interaction.id
          } else if (event.event_type === 'step.delta' && event.delta.type === 'text') {
            turnText += event.delta.text
            sendTurn({ type: 'text', delta: event.delta.text })
          } else if (event.event_type === 'step.start') {
            if (event.step.type === 'function_call') {
              calls.set(event.step.id, event.step)
            } else if (event.step.type === 'google_search_call') {
              sendTurn({ type: 'tool', name: 'web_search' })
            }
          } else if (event.event_type === 'interaction.completed') {
            interaction = event.interaction
          }
        }

        if (!interaction?.id) throw new Error('Gemini returned no completed interaction.')
        workingInteractionId = interaction.id
        for (const step of interaction.steps ?? []) {
          if (step.type === 'function_call') calls.set(step.id, step)
        }
        const functionCalls = [...calls.values()]
        if (!functionCalls.length) break
        if (round === MAX_TOOL_ROUNDS) {
          throw new Error('Gemini exceeded the maximum tool-call rounds.')
        }

        const pendingResults = []
        for (const call of functionCalls) {
          const definition = toolMap.get(call.name)
          let result
          if (!definition) {
            result = {
              isError: true,
              content: [{ type: 'text', text: 'This tool is not available.' }],
            }
          } else if (!decideTool(call.name)) {
            result = {
              isError: true,
              content: [{
                type: 'text',
                text: 'Blocked: JARVIS is running in read-only mode and cannot take actions that change anything. Tell the user this action is unavailable until they enable write access on the machine.',
              }],
            }
          } else {
            if (
              call.name !== 'mcp__jarvis__display' &&
              !call.name.startsWith('mcp__jarvis_ui__')
            ) {
              sendTurn({ type: 'tool', name: call.name })
            }
            try {
              result = await toolRegistry.call(call.name, call.arguments)
            } catch (error) {
              result = {
                isError: true,
                content: [{ type: 'text', text: String(error?.message ?? error) }],
              }
            }
          }

          pendingResults.push({
            type: 'function_result',
            call_id: call.id,
            name: call.name,
            result: functionResult(result),
            is_error: result?.isError === true,
          })
        }
        nextInput = pendingResults
      }

      previousInteractionId = workingInteractionId
      completedTurns += 1
      if (completedTurns >= MAX_HISTORY_TURNS) {
        previousInteractionId = null
        completedTurns = 0
      }
      sendTurn({ type: 'done', text: turnText })
    } catch (error) {
      if (controller?.signal.aborted) {
        sendTurn({ type: 'done', text: turnText })
      } else {
        console.error('[jarvis] turn failed:', error)
        sendTurn({ type: 'error', message: String(error?.message ?? error) })
      }
    } finally {
      controller = null
      activeInteractionId = null
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
      const text = message.text
      queue = queue.then(() => runTurn(id, text)).catch((error) => {
        console.error('[jarvis] turn queue failed:', error)
      })
    } else if (message.type === 'interrupt') {
      controller?.abort()
      if (activeInteractionId) {
        void ai.interactions.cancel(activeInteractionId).catch(() => {})
      }
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

  socket.on('error', (error) => {
    console.warn('[jarvis] websocket error:', error.message)
  })

  return () => {
    if (!closed) socket.close()
  }
}