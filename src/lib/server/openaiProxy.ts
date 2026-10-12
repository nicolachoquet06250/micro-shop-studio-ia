export interface OpenAiProxyCredentials {
  baseUrl: string;
  apiKey: string;
}

export interface OpenAiProxyRequest extends OpenAiProxyCredentials {
  path: '/models' | '/chat/completions' | '/tokenize';
  method: 'GET' | 'POST';
  body?: unknown;
  signal?: AbortSignal;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

function validateTarget(baseUrl: string): string {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) {
    throw new Error("L'URL de base de l'API est vide.");
  }

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error("L'URL de base de l'API est invalide.");
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error("L'URL de base doit utiliser HTTP ou HTTPS.");
  }

  return normalized;
}

export function parseProxyCredentials(value: unknown): OpenAiProxyCredentials {
  if (!value || typeof value !== 'object') {
    throw new Error('Corps de requête invalide.');
  }

  const candidate = value as Record<string, unknown>;
  const baseUrl = typeof candidate.baseUrl === 'string' ? candidate.baseUrl.trim() : '';
  const apiKey = typeof candidate.apiKey === 'string' ? candidate.apiKey.trim() : '';

  if (!baseUrl) throw new Error("L'URL de base de l'API est requise.");
  if (!apiKey) throw new Error("La clé API est requise.");

  return { baseUrl, apiKey };
}

/**
 * Relaye la réponse amont sans la bufferiser.
 *
 * C'est indispensable pour /chat/completions avec stream=true : le ReadableStream
 * SSE de l'API OpenAI-compatible est renvoyé tel quel au navigateur, chunk par
 * chunk. On ne lit donc volontairement jamais response.text()/json()/arrayBuffer()
 * ici.
 */
export async function proxyOpenAiRequest(input: OpenAiProxyRequest): Promise<Response> {
  const baseUrl = validateTarget(input.baseUrl);
  const target = `${baseUrl}${input.path}`;

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: input.method,
      headers: {
        Accept: input.path === '/chat/completions'
          ? 'text/event-stream, application/json'
          : 'application/json',
        Authorization: `Bearer ${input.apiKey}`,
        ...(new URL(baseUrl).hostname === 'api.anthropic.com'
          ? { 'anthropic-version': '2023-06-01' }
          : {}),
        ...(input.method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
      },
      body: input.method === 'POST' ? JSON.stringify(input.body ?? {}) : undefined,
      redirect: 'follow',
      cache: 'no-store',
      signal: input.signal,
    });
  } catch (error) {
    if (input.signal?.aborted) {
      return Response.json(
        {
          error: {
            type: 'request_aborted',
            message: 'La requête vers l’API OpenAI-compatible a été annulée.',
          },
        },
        { status: 499, headers: { 'Cache-Control': 'no-store' } },
      );
    }

    const message = error instanceof Error ? error.message : String(error);
    return Response.json(
      {
        error: {
          type: 'upstream_connection_error',
          message: `Impossible de joindre l'API OpenAI-compatible: ${message}`,
        },
      },
      { status: 502, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const contentType = upstream.headers.get('content-type') ?? 'application/json; charset=utf-8';
  const isEventStream = contentType.toLowerCase().includes('text/event-stream');
  const headers = new Headers({
    'Content-Type': contentType,
    'Cache-Control': isEventStream ? 'no-cache, no-transform' : 'no-store',
  });

  // Utile derrière nginx : évite que le reverse proxy ré-agrège les chunks SSE.
  if (isEventStream) headers.set('X-Accel-Buffering', 'no');

  // Quelques métadonnées diagnostiques peuvent être relayées sans exposer la clé.
  for (const name of ['x-request-id', 'openai-processing-ms', 'retry-after']) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }

  // Ne pas recopier Content-Length / Content-Encoding / Transfer-Encoding : le
  // runtime Node/Astro doit gérer le framing du flux lui-même.
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}
