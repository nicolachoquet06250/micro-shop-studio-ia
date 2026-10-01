import type { APIRoute } from 'astro';
import { parseProxyCredentials, proxyOpenAiRequest } from '../../../../lib/server/openaiProxy';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  try {
    const input = await request.json();
    const credentials = parseProxyCredentials(input);
    const payload = input && typeof input === 'object' && 'payload' in input
      ? (input as Record<string, unknown>).payload
      : undefined;

    if (!payload || typeof payload !== 'object') {
      return Response.json(
        {
          error: {
            type: 'invalid_proxy_request',
            message: 'Le payload OpenAI est requis.',
          },
        },
        { status: 400, headers: { 'Cache-Control': 'no-store' } },
      );
    }

    return proxyOpenAiRequest({
      ...credentials,
      path: '/chat/completions',
      method: 'POST',
      body: payload,
      signal: request.signal,
    });
  } catch (error) {
    return Response.json(
      {
        error: {
          type: 'invalid_proxy_request',
          message: error instanceof Error ? error.message : String(error),
        },
      },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  }
};
