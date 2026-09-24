import { createServer } from 'node:http';
import { createConfiguredHttpHandler } from './config/http-handler.js';

const port = integerEnvironment('PORT', 3000);
const handler = createConfiguredHttpHandler();

createServer((request, response) => {
  void handler(request, response);
}).listen(port, () => {
  console.log(`Conductor runtime listening on port ${port}`);
});

function integerEnvironment(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`${name} must be a valid TCP port`);
  }
  return parsed;
}
