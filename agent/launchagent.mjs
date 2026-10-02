#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORTAL } from './lib/env.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const xml = (value) => String(value).replace(/[<>&"']/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char]);
const args = process.argv.slice(2);
const index = args.indexOf('--output');
const output = index >= 0 ? args[index + 1] : path.join(project, 'agent/runs/com.advantage.outbound-sales-agent.plist');
if (!output || output.startsWith('--')) throw new Error('Supply a path after --output');
fs.mkdirSync(path.join(project, 'agent/runs'), { recursive: true });
const text = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.advantage.outbound-sales-agent</string>
  <key>ProgramArguments</key><array>
    <string>${xml(process.execPath)}</string>
    <string>${xml(path.join(project, 'agent/worker.mjs'))}</string>
    <string>--portal</string><string>${xml(DEFAULT_PORTAL)}</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(project)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>60</integer>
  <key>StandardOutPath</key><string>${xml(path.join(project, 'agent/runs/worker.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(project, 'agent/runs/worker.log'))}</string>
</dict></plist>
`;
fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
fs.writeFileSync(output, text);
console.log(path.resolve(output));
