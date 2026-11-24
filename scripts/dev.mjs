// Runs the API server (watch mode) and the Vite dev server together.
// Open http://127.0.0.1:5173 (Spotify needs 127.0.0.1, not "localhost").
import { spawn } from 'node:child_process';

const env = { ...process.env, PUBLIC_URL: process.env.PUBLIC_URL ?? 'http://127.0.0.1:5173' };
const procs = [
  spawn('npm', ['run', 'dev', '-w', 'server'], { stdio: 'inherit', env, shell: process.platform === 'win32' }),
  spawn('npm', ['run', 'dev', '-w', 'web'], { stdio: 'inherit', env, shell: process.platform === 'win32' }),
];
const stop = () => procs.forEach((p) => p.kill());
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
procs.forEach((p) => p.on('exit', (code) => { if (code) { stop(); process.exit(code); } }));
