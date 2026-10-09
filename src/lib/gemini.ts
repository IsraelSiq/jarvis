import { GoogleGenAI } from '@google/genai'
import { env, MODEL, SYSTEM_PROMPT, activeServers } from '../config'

const client = new GoogleGenAI({ apiKey: env.geminiKey })
const MAX_HISTORY_TURNS = 12

export type Msg = { role: 'user' | 'assistant'; content: string }

export type AskHandlers = {
  onText: (delta: string) => void
  onTool: (name: string) => void
}

let active: AbortController | null = null
let previousInteractionId: string | null = null
let completedTurns = 0
let activeInteractionId: string | null = null

export async function ask(
  history: Msg[],
  handlers: AskHandlers,
): Promise<{ text: string; tools: string[] }> {
  const controller = new AbortController()
  active = controller
  activeInteractionId = null
  const servers = activeServers()
  const tools = [
    { type: 'google_search' as const },
    ...servers.map((server) => ({
      type: 'mcp_server' as const,
      name: server.name.replace(/-/g, '_'),
      url: server.url,
      ...(server.token ? { headers: { Authorization: `Bearer ${server.token}` } } : {}),
    })),
  ]
  const text = history.at(-1)?.content ?? ''
  const usedTools: string[] = []
  let output = ''
  let interactionId: string | null = null

  try {
    const stream = await client.interactions.create(
      {
        model: MODEL,
        input: text,
        system_instruction: SYSTEM_PROMPT,
        tools,
        generation_config: { max_output_tokens: 4096, tool_choice: 'validated' },
        store: true,
        stream: true,
        ...(completedTurns < MAX_HISTORY_TURNS && previousInteractionId
          ? { previous_interaction_id: previousInteractionId }
          : {}),
      },
      { signal: controller.signal },
    )

    for await (const event of stream) {
      if (event.event_type === 'interaction.created') {
        activeInteractionId = event.interaction.id
      } else if (event.event_type === 'step.delta' && event.delta.type === 'text') {
        output += event.delta.text
        handlers.onText(event.delta.text)
      } else if (event.event_type === 'step.start') {
        const step = event.step
        if (step.type === 'mcp_server_tool_call') {
          const name = `${step.server_name} · ${step.name.replace(/_/g, ' ')}`
          usedTools.push(name)
          handlers.onTool(name)
        }
      } else if (event.event_type === 'interaction.completed') {
        interactionId = event.interaction.id
      }
    }

    if (interactionId) {
      previousInteractionId = interactionId
      completedTurns += 1
      if (completedTurns >= MAX_HISTORY_TURNS) {
        previousInteractionId = null
        completedTurns = 0
      }
    }
    return { text: output.trim(), tools: usedTools }
  } finally {
    activeInteractionId = null
    if (active === controller) active = null
  }
}

export function cancel(): void {
  active?.abort()
  if (activeInteractionId) {
    void client.interactions.cancel(activeInteractionId).catch(() => {})
  }
}

export function connectedLabels(): string[] {
  return activeServers().map((server) => server.label)
}