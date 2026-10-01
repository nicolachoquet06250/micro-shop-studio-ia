import type { APIRoute } from 'astro';
import { parseProxyCredentials, proxyOpenAiRequest } from '../../../lib/server/openaiProxy';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  try {
    const payload = await request.json();
    const credentials = parseProxyCredentials(payload);

    return proxyOpenAiRequest({
      ...credentials,
      path: '/models',
      method: 'GET',
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
