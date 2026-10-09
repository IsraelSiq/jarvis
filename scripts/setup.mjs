#!/usr/bin/env node
// JARVIS preflight — a friendly, advisory check you run with `npm run setup`.
//
// It changes nothing and installs nothing. It looks at your machine, tells you
// what is ready and what is missing, and prints the two commands that start
// JARVIS. Every check degrades to a single friendly line if something is not
// there, and the script always exits 0 — it is advice, not a gate.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadEnv } from 'vite';

const tick = '  ok  ';
const warn = ' note ';
const info = '  ·   ';

function line(tag, msg) {
  console.log(`[${tag}] ${msg}`);
}

console.log('');
console.log('JARVIS preflight — checking your machine (nothing is changed)');
console.log('------------------------------------------------------------');

// --- Node version --------------------------------------------------------
try {
  const major = Number(process.versions.node.split('.')[0]);
  if (Number.isFinite(major) && major >= 20) {
    line(tick, `Node.js ${process.versions.node} (20+ required).`);
  } else {
    line(warn, `Node.js ${process.versions.node} is below 20. Please upgrade — the bridge needs Node 20 or newer.`);
  }
} catch {
  line(warn, 'Could not read the Node.js version. JARVIS needs Node 20 or newer.');
}

const localEnv = loadEnv('development', process.cwd(), '');
const provider = (process.env.JARVIS_PROVIDER || localEnv.JARVIS_PROVIDER || 'gemini').trim().toLowerCase();
if (provider === 'ollama') {
  const model = process.env.JARVIS_MODEL || localEnv.JARVIS_MODEL || 'qwen3:4b';
  try {
    const response = await fetch('http://localhost:11434/api/tags', {
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const installed = (data.models ?? []).some((entry) => entry.name === model);
    if (installed) {
      line(tick, `Ollama is running and ${model} is installed.`);
    } else {
      line(warn, `Ollama is running, but ${model} is not installed.`);
      line(info, `Run: ollama pull ${model}`);
    }
  } catch {
    line(warn, 'Ollama is selected but its local API is not responding.');
    line(info, 'Install and open Ollama, then run: ollama pull ' + model);
  }
} else if (provider === 'gemini') {
  const bridgeGeminiKey = process.env.GEMINI_API_KEY || localEnv.GEMINI_API_KEY;
  if (bridgeGeminiKey && bridgeGeminiKey.trim()) {
    line(tick, 'Gemini API key found for the bridge.');
  } else if (localEnv.VITE_GEMINI_API_KEY && localEnv.VITE_GEMINI_API_KEY.trim()) {
    line(info, 'VITE_GEMINI_API_KEY found for direct mode; bridge mode still needs GEMINI_API_KEY.');
  } else {
    line(warn, 'GEMINI_API_KEY is not set. Gemini bridge mode needs an API key.');
    line(info, 'Create one at https://aistudio.google.com/apikey and set GEMINI_API_KEY, or select JARVIS_PROVIDER=ollama.');
    line(info, 'For direct mode, set VITE_GEMINI_API_KEY in .env.local instead (it is exposed in the browser).');
  }
} else {
  line(warn, `Unknown JARVIS_PROVIDER "${provider}". Use gemini or ollama.`);
}

// --- Gemini CLI MCP servers ----------------------------------------------
const geminiSettingsPath = join(homedir(), '.gemini', 'settings.json');
let mcpCount = 0;
try {
  const raw = readFileSync(geminiSettingsPath, 'utf8');
  let parsed = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {};
  }
  const servers = parsed && typeof parsed.mcpServers === 'object' && parsed.mcpServers ? parsed.mcpServers : {};
  mcpCount = Object.keys(servers).length;
  if (mcpCount > 0) {
    line(tick, `~/.gemini/settings.json found with ${mcpCount} MCP server${mcpCount === 1 ? '' : 's'} configured.`);
  } else {
    line(info, '~/.gemini/settings.json found, but no MCP servers are configured yet. JARVIS still answers and drives its own interface.');
  }
} catch {
  line(info, '~/.gemini/settings.json not found. JARVIS works without extra MCP servers.');
}

// --- ElevenLabs key (env or the elevenlabs MCP entry) --------------------
function findElevenLabsKey() {
  if (process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_API_KEY.trim()) {
    return 'environment (ELEVENLABS_API_KEY)';
  }
  try {
    const raw = readFileSync(geminiSettingsPath, 'utf8');
    const parsed = JSON.parse(raw);
    const servers = parsed && parsed.mcpServers ? parsed.mcpServers : {};
    const el = servers.elevenlabs;
    const env = el && el.env ? el.env : {};
    if (env.ELEVENLABS_API_KEY && String(env.ELEVENLABS_API_KEY).trim()) {
      return 'the elevenlabs MCP server in ~/.gemini/settings.json';
    }
  } catch {
    // ignore — no key discoverable
  }
  return null;
}

const elSource = findElevenLabsKey();
if (elSource) {
  line(tick, `Premium voice available — ElevenLabs key found via ${elSource}.`);
} else {
  line(info, 'No ElevenLabs key found — JARVIS will use browser speech (that is completely fine).');
  line(info, '  Optional: add ELEVENLABS_API_KEY for a better voice and Scribe transcription. The free tier is enough for a demo.');
}

// --- How to run ----------------------------------------------------------
console.log('');
console.log('To run JARVIS, open two terminals:');
console.log(
  `  1)  npm run bridge      # the ${provider === 'ollama' ? 'local Ollama brain' : 'Gemini brain'} and MCP tools`,
);
console.log('  2)  npm run dev         # the face (open http://localhost:5173 in Chrome)');
console.log('');
console.log('Then click INITIALISE and say "Hey Jarvis".');
console.log('To let JARVIS take real actions (phone, browser, sending), run `npm run bridge:writes` instead of `npm run bridge`.');
console.log('');

process.exit(0);
