#!/usr/bin/env node
import {
  handlePostToolBatch,
  handlePostToolUseAgent,
  handlePreToolUseAgent,
  handleSubagentStart,
  handleSubagentStop,
  handleTaskCompleted,
  handleTaskCreated,
  handleUserPromptSubmit
} from '../lib/guard.js';

async function readStdin() {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  return input ? JSON.parse(input) : {};
}

function emit(result) {
  if (result.stdout) {
    process.stdout.write(`${JSON.stringify(result.stdout)}\n`);
  }
  if (result.stderr) {
    process.stderr.write(`${result.stderr}\n`);
  }
  process.exitCode = result.exitCode ?? 0;
}

const handlers = {
  'pretool-agent': handlePreToolUseAgent,
  'posttool-batch': handlePostToolBatch,
  'posttool-agent': handlePostToolUseAgent,
  'subagent-start': handleSubagentStart,
  'subagent-stop': handleSubagentStop,
  'task-created': handleTaskCreated,
  'task-completed': handleTaskCompleted,
  'user-prompt-submit': handleUserPromptSubmit
};

async function main() {
  const action = process.argv[2];
  const handler = handlers[action];

  if (!handler) {
    throw new Error(`Unknown hook action: ${action || '(missing)'}`);
  }

  const input = await readStdin();
  emit(await handler(input, process.env));
}

main().catch((error) => {
  process.stderr.write(`subagent-budget-guard hook error: ${error.stack || error.message}\n`);
  process.exitCode = 1;
});
