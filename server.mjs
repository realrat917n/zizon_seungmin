import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI, Type } from '@google/genai';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3000);
const model = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const ai = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;
const configuredModels = (process.env.GEMINI_MODELS || '').split(',').map(value => value.trim()).filter(Boolean);
const MODEL_PREFERENCES = [model, ...configuredModels.filter(value => value !== model)];
let modelChain = [...MODEL_PREFERENCES];
let modelCursor = 0;
const cache = new Map();
const CACHE_TTL = 10 * 60 * 1000;
const CACHE_LIMIT = 100;

const responseSchema = {
  type: Type.OBJECT,
  properties: {
    status: { type: Type.STRING, enum: ['good', 'improve'] },
    summary: { type: Type.STRING },
    analysis: { type: Type.STRING },
    intent: { type: Type.STRING },
    tone: { type: Type.STRING },
    suggestions: {
      type: Type.ARRAY,
      maxItems: 2,
      items: {
        type: Type.OBJECT,
        properties: { label: { type: Type.STRING }, text: { type: Type.STRING } },
        required: ['label', 'text'],
      },
    },
  },
  required: ['status', 'summary', 'analysis', 'intent', 'tone', 'suggestions'],
};

const systemPrompt = `친구에게 보낼 한국어 메시지를 짧게 분석해라. 원문의 의도와 말투를 유지하고 무관한 문장을 덧붙이지 마라. 자연스러우면 good과 빈 suggestions를 반환하라. 수정이 필요할 때만 실제로 보낼 문장 최대 2개를 제안하라. 모든 값은 한국어로 작성하라. summary는 1문장, analysis는 2문장 이내, intent와 tone은 짧게 작성하라.`;

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 12000) reject(new Error('request_too_large'));
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function discoverFallbackModel() {
  if (!ai) return;
  try {
    const available = [];
    const models = await ai.models.list();
    for await (const item of models) {
      const name = item.name?.replace(/^models\//, '');
      if (name && item.supportedActions?.includes('generateContent') && /flash/i.test(name) && !/(image|tts)/i.test(name) && !/^gemini-2\.5/i.test(name) && name !== model) available.push(name);
    }
    const preferredAvailable = MODEL_PREFERENCES.filter(name => available.includes(name));
    const discoveredFallbacks = available.filter(name => !MODEL_PREFERENCES.includes(name)).sort((a, b) => {
      const score = name => name === 'gemini-flash-latest' ? 0 : name === 'gemini-flash-lite-latest' ? 1 : 2;
      return score(a) - score(b);
    });
    const ordered = preferredAvailable.length ? [...preferredAvailable, ...discoveredFallbacks] : [model, ...discoveredFallbacks];
    if (ordered.length) modelChain = [...new Set(ordered)];
    console.log('Gemini available fallback models:', JSON.stringify(available));
    console.log('Gemini model chain:', JSON.stringify(modelChain));
  } catch (error) {
    console.error('Gemini model discovery failed:', error);
  }
}

function parseJsonResponse(text) {
  if (typeof text !== 'string') throw new Error('empty_gemini_response');
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('invalid_gemini_json');
  return JSON.parse(trimmed.slice(start, end + 1));
}

async function analyze(req, res) {
  if (!ai) return json(res, 503, { error: 'AI service is not configured' });
  try {
    const body = JSON.parse(await readBody(req));
    const message = typeof body.message === 'string' ? body.message.trim().slice(0, 500) : '';
    if (!message) return json(res, 400, { error: 'Message must be a non-empty string' });
    const cacheKey = message.replace(/\s+/g, ' ');
    const cached = cache.get(cacheKey);
    if (cached && cached.expires > Date.now()) {
      console.log('Gemini cache hit');
      return json(res, 200, cached.result);
    }
    if (cached) cache.delete(cacheKey);
    let lastError;
    let quotaHit = false;
    const primaryIndex = modelCursor % modelChain.length;
    modelCursor += 1;
    const requestModels = [
      modelChain[primaryIndex],
      modelChain[(primaryIndex + 1) % modelChain.length],
    ].filter((value, index, values) => value && values.indexOf(value) === index);
    for (let index = 0; index < requestModels.length && index < 2; index += 1) {
      const activeModel = requestModels[index];
      const isFallback = index > 0;
      try {
        console.log('Gemini API request:', JSON.stringify({ model: activeModel, fallback: isFallback }));
        const response = await ai.models.generateContent({
          model: activeModel,
          contents: `${systemPrompt}\n\n사용자 메시지:\n${message}`,
          config: { responseMimeType: 'application/json', responseSchema, temperature: 0.2, maxOutputTokens: 600, thinkingConfig: { thinkingBudget: 0 } },
        });
        const text = response.text || response.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('');
        console.log('Gemini API success:', JSON.stringify({ model: activeModel, status: 200, fallback: isFallback }));
        const result = parseJsonResponse(text);
        if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
        cache.set(cacheKey, { result, expires: Date.now() + CACHE_TTL });
        return json(res, 200, result);
      } catch (error) {
        lastError = error;
        const status = error?.status || 500;
        quotaHit ||= status === 429;
        console.error('Gemini API failure:', JSON.stringify({ model: activeModel, status, fallback: isFallback, message: error?.message?.slice(0, 240) }));
        if (status === 503 && index === 0) await new Promise(resolve => setTimeout(resolve, 400));
        if (![404, 429, 503].includes(status)) break;
      }
    }
    const error = quotaHit ? 'quota_exceeded' : lastError?.status === 503 ? 'temporarily_unavailable' : 'AI analysis failed';
    return json(res, quotaHit ? 429 : 502, { error });
  } catch (error) {
    console.error('Gemini analysis failed:', error);
    const quota = error?.status === 429 || error?.status === 503;
    return json(res, quota ? 429 : 502, { error: quota ? 'quota_exceeded' : 'AI analysis failed' });
  }
}

const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };

async function serveStatic(req, res) {
  const requested = decodeURIComponent(new URL(req.url, `http://${req.headers.host}`).pathname);
  const relative = requested === '/' ? '/index.html' : requested;
  const filePath = path.resolve(root, `.${relative}`);
  if (!filePath.startsWith(root)) return json(res, 403, { error: 'Forbidden' });
  try {
    const content = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': contentTypes[path.extname(filePath)] || 'application/octet-stream' });
    res.end(content);
  } catch { json(res, 404, { error: 'Not found' }); }
}

http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/analyze') return analyze(req, res);
  if (req.method === 'GET') return serveStatic(req, res);
  return json(res, 405, { error: 'Method not allowed' });
}).listen(port, '0.0.0.0', () => {
  console.log(`Error Log server listening on ${port} with Gemini model ${model}`);
  discoverFallbackModel();
});
