#!/usr/bin/env node

import { execFileSync } from 'child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import path from 'path';

const CHANNELS = ['feishu_hire', 'email_resume'];
const WRITEBACK_MODES = new Set(['preview', 'apply']);

main();

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }
  if (!args.workdir) fail('Missing --workdir.');

  const writebackMode = args.writeback || 'preview';
  if (!WRITEBACK_MODES.has(writebackMode)) fail('Invalid --writeback. Expected preview or apply.');

  const repoRoot = path.resolve(import.meta.dirname, '..');
  const workdir = path.resolve(args.workdir);
  const runId = formatBeijingForFile(new Date());
  const pipelineDir = path.join(workdir, 'pipeline-runs');
  mkdirSync(pipelineDir, { recursive: true });
  const lockPath = path.join(workdir, 'pipeline.lock');
  acquireLock(lockPath, {
    type: 'pipeline',
    run_id: runId,
    workdir,
    created_at: nowBeijingIso(),
  });

  const summary = {
    run_id: runId,
    started_at: nowBeijingIso(),
    finished_at: null,
    writeback_mode: writebackMode,
    channels: [],
    summary: {
      collected_files: 0,
      evaluated_files: 0,
      preview_files: 0,
      applied_files: 0,
      skipped_empty: 0,
      failed: 0,
    },
  };

  try {
    for (const channel of CHANNELS) {
      const item = runChannel({ channel, workdir, repoRoot, writebackMode });
      summary.channels.push(item);
      if (item.collected_file) summary.summary.collected_files += 1;
      if (item.evaluated_file) summary.summary.evaluated_files += 1;
      if (item.preview_file) summary.summary.preview_files += 1;
      if (item.result_file) summary.summary.applied_files += 1;
      if (item.status === 'skipped_empty') summary.summary.skipped_empty += 1;
      if (item.status === 'failed') summary.summary.failed += 1;
    }

    summary.finished_at = nowBeijingIso();
    const outputPath = path.join(pipelineDir, `${runId}.pipeline-result.json`);
    writeJson(outputPath, summary);

    console.log(`[pipeline] result=${outputPath}`);
    console.log(`[pipeline] collected=${summary.summary.collected_files}, evaluated=${summary.summary.evaluated_files}, preview=${summary.summary.preview_files}, applied=${summary.summary.applied_files}, skipped_empty=${summary.summary.skipped_empty}, failed=${summary.summary.failed}`);
    if (summary.summary.failed > 0) process.exitCode = 1;
  } finally {
    releaseLock(lockPath);
  }
}

function runChannel({ channel, workdir, repoRoot, writebackMode }) {
  const item = {
    channel,
    status: 'started',
    collected_file: null,
    evaluated_file: null,
    preview_file: null,
    result_file: null,
    candidates: 0,
    error: null,
  };

  try {
    console.log(`[pipeline] collect ${channel}`);
    const collect = runNode(repoRoot, 'scripts/collect-recruitment-data.mjs', [
      '--channel',
      channel,
      '--workdir',
      workdir,
    ]);
    item.collected_file = parseOutputPath(collect.stdout, 'collector');
    const collected = readJson(item.collected_file, 'collected JSON');
    item.candidates = collected.summary?.total ?? collected.candidates?.length ?? 0;

    if (item.candidates === 0) {
      item.status = 'skipped_empty';
      return item;
    }

    console.log(`[pipeline] evaluate ${item.collected_file}`);
    const evaluate = runNode(repoRoot, 'scripts/evaluate-recruitment-data.mjs', [
      '--input',
      item.collected_file,
      '--workdir',
      workdir,
    ]);
    item.evaluated_file = parseOutputPath(evaluate.stdout, 'evaluator') || expectedEvaluatedPath(workdir, item.collected_file);

    console.log(`[pipeline] writeback preview ${item.evaluated_file}`);
    const preview = runNode(repoRoot, 'scripts/writeback-evaluation-results.mjs', [
      '--mode',
      'preview',
      '--input',
      item.evaluated_file,
      '--workdir',
      workdir,
    ]);
    item.preview_file = parseOutputPath(preview.stdout, 'writeback preview') || expectedPreviewPath(workdir, item.evaluated_file);

    if (writebackMode === 'apply') {
      console.log(`[pipeline] writeback apply ${item.preview_file}`);
      const apply = runNode(repoRoot, 'scripts/writeback-evaluation-results.mjs', [
        '--mode',
        'apply',
        '--input',
        item.preview_file,
        '--workdir',
        workdir,
      ]);
      item.result_file = parseOutputPath(apply.stdout, 'writeback result') || expectedResultPath(workdir, item.preview_file);
    }

    item.status = 'completed';
    return item;
  } catch (error) {
    item.status = 'failed';
    item.error = error.message;
    return item;
  }
}

function runNode(repoRoot, script, args) {
  try {
    const stdout = execFileSync('node', [path.join(repoRoot, script), ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 30 * 60 * 1000,
      maxBuffer: 50 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    process.stdout.write(stdout);
    return { stdout };
  } catch (error) {
    const stdout = error.stdout?.toString() || '';
    const stderr = error.stderr?.toString() || '';
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    throw new Error(stderr.trim() || stdout.trim() || error.message);
  }
}

function parseOutputPath(stdout, source) {
  const patterns = [
    /\[collector\] output=(.+)/,
    /\[evaluator\] output=(.+)/,
    /\[evaluator\] already completed: (.+)/,
    /\[writeback\] preview=(.+)/,
    /\[writeback\] result=(.+)/,
  ];
  for (const pattern of patterns) {
    const match = stdout.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  if (source) console.warn(`[pipeline] cannot parse ${source} output path`);
  return null;
}

function expectedEvaluatedPath(workdir, collectedFile) {
  return path.join(workdir, 'evaluated', `${path.basename(collectedFile, '.json')}.evaluated.json`);
}

function expectedPreviewPath(workdir, evaluatedFile) {
  return path.join(workdir, 'write-preview', `${path.basename(evaluatedFile, '.evaluated.json')}.write-preview.json`);
}

function expectedResultPath(workdir, previewFile) {
  return path.join(workdir, 'write-result', `${path.basename(previewFile, '.write-preview.json')}.write-result.json`);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--workdir') {
      args.workdir = argv[++i];
    } else if (arg === '--writeback') {
      args.writeback = argv[++i];
    } else {
      fail(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function printUsage() {
  console.log(`Usage:
  node scripts/run-recruitment-pipeline.mjs --workdir workspace
  node scripts/run-recruitment-pipeline.mjs --workdir workspace --writeback apply`);
}

function readJson(filePath, label) {
  if (!existsSync(filePath)) fail(`${label} not found: ${filePath}`);
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    fail(`Cannot parse ${label}: ${filePath}: ${error.message}`);
  }
}

function writeJson(filePath, data) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function fail(message) {
  console.error(`[pipeline] ${message}`);
  process.exit(1);
}

function acquireLock(lockPath, payload) {
  try {
    const fd = openSync(lockPath, 'wx');
    try {
      writeFileSync(fd, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (error.code === 'EEXIST') {
      fail(`Pipeline is already running. Lock exists: ${lockPath}`);
    }
    throw error;
  }
}

function releaseLock(lockPath) {
  rmSync(lockPath, { force: true });
}

function nowBeijingIso() {
  const beijingMs = Date.now() + 8 * 60 * 60 * 1000;
  return `${new Date(beijingMs).toISOString().slice(0, 19)}+08:00`;
}

function formatBeijingForFile(date) {
  const beijingMs = date.getTime() + 8 * 60 * 60 * 1000;
  return new Date(beijingMs).toISOString().slice(0, 19).replace(/[-:T]/g, '').replace(/^(\d{8})(\d{6})$/, '$1_$2');
}
