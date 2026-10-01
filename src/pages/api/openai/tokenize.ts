import type { APIRoute } from 'astro';
import { parseProxyCredentials, proxyOpenAiRequest } from '../../../lib/server/openaiProxy';

export const prerender = false;

const FALLBACK_CHARS_PER_TOKEN = 3;
const unsupportedUpstreams = new Set<string>();

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (!part || typeof part !== 'object') return '';
    const candidate = part as Record<string, unknown>;
    return candidate.type === 'text' && typeof candidate.text === 'string'
      ? candidate.text
      : candidate.type === 'image_url'
        ? '[IMAGE]'
        : '';
  }).join('\n');
}

function estimateTextTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / FALLBACK_CHARS_PER_TOKEN));
}

function estimatePayloadTokens(payload: Record<string, unknown>): number {
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  if (messages.length) {
    return messages.reduce((total, rawMessage) => {
      if (!rawMessage || typeof rawMessage !== 'object') return total;
      const message = rawMessage as Record<string, unknown>;
      return total + 8 + estimateTextTokens(contentToText(message.content));
    }, 4);
  }

  if (typeof payload.prompt === 'string') return estimateTextTokens(payload.prompt);
  if (typeof payload.text === 'string') return estimateTextTokens(payload.text);
  if (typeof payload.input === 'string') return estimateTextTokens(payload.input);

  return estimateTextTokens(JSON.stringify(payload));
}

function fallbackResponse(payload: Record<string, unknown>, upstreamStatus?: number): Response {
  const count = estimatePayloadTokens(payload);
  return Response.json({
    count,
    source: 'estimated',
    tokenizer: 'local-conservative-estimate',
    ...(upstreamStatus ? { upstream_status: upstreamStatus } : {}),
  }, {
    status: 200,
    headers: { 'Cache-Control': 'no-store' },
  });
}

export const POST: APIRoute = async ({ request }) => {
  try {
    const input = await request.json();
    const credentials = parseProxyCredentials(input);
    const payload = input && typeof input === 'object' && 'payload' in input
      ? (input as Record<string, unknown>).payload
      : undefined;

    if (!payload || typeof payload !== 'object') {
      return Response.json(
        { error: { type: 'invalid_proxy_request', message: 'Le payload de tokenisation est requis.' } },
        { status: 400, headers: { 'Cache-Control': 'no-store' } },
      );
    }

    const typedPayload = payload as Record<string, unknown>;
    const model = typeof typedPayload.model === 'string' ? typedPayload.model : '';
    const upstreamKey = `${credentials.baseUrl.replace(/\/+$/, '')}::${model}`;

    // La route locale /api/openai/tokenize est toujours disponible. L'endpoint
    // /tokenize du provider n'est qu'une optimisation pour obtenir le tokenizer exact.
    if (unsupportedUpstreams.has(upstreamKey)) {
      return fallbackResponse(typedPayload);
    }

    const upstream = await proxyOpenAiRequest({
      ...credentials,
      path: '/tokenize',
      method: 'POST',
      body: typedPayload,
      signal: request.signal,
    });

    if (upstream.ok) {
      return upstream;
    }

    // Ne jamais exposer au navigateur un 404/405/501 provenant du tokenizer
    // optionnel du provider : la route locale reste fonctionnelle et bascule
    // immédiatement sur un comptage conservateur.
    if ([404, 405, 410, 501].includes(upstream.status)) {
      unsupportedUpstreams.add(upstreamKey);
    }

    return fallbackResponse(typedPayload, upstream.status);
  } catch (error) {
    if (request.signal.aborted) {
      return Response.json(
        { error: { type: 'request_aborted', message: 'La tokenisation a été annulée.' } },
        { status: 499, headers: { 'Cache-Control': 'no-store' } },
      );
    }

    return Response.json(
      { error: { type: 'invalid_proxy_request', message: error instanceof Error ? error.message : String(error) } },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  }
};
