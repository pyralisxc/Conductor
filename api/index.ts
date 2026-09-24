import type { IncomingMessage, ServerResponse } from 'node:http';
import { createConfiguredHttpHandler } from '../src/config/http-handler.js';

let handler: ReturnType<typeof createConfiguredHttpHandler> | undefined;

function conductorHandler(): ReturnType<typeof createConfiguredHttpHandler> {
  if (handler) return handler;
  handler = createConfiguredHttpHandler();
  return handler;
}

export default async function vercelHandler(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  await conductorHandler()(request, response);
}
