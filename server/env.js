// Load startup configuration before any router opens the database. Imports used
// by tests remain inert and use only their explicitly provided environment.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const entry = fileURLToPath(new URL('./server.js', import.meta.url));
const envPath = fileURLToPath(new URL('../.env', import.meta.url));
if (process.argv[1] && path.resolve(process.argv[1]) === entry && existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
}
