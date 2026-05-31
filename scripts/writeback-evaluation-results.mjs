#!/usr/bin/env node

import { execFileSync } from 'child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import path from 'path';

const MODES = new Set(['preview', 'apply']);

main();

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }
  if (!MODES.has(args.mode)) fail('Missing or invalid --mode. Expected preview or apply.');
  if (!args.input) fail('Missing --input.');
  if (!args.workdir) fail('Missing --workdir.');

  const workdir = path.resolve(args.workdir);
  const inputPath = path.resolve(args.input);

  if (args.mode === 'preview') {
    runPreview(inputPath, workdir);
  } else {
    runApply(inputPath, workdir);
  }
}

function runPreview(evaluatedPath, workdir) {
  const configPath = path.join(workdir, 'writeback-config.json');
  const previewDir = path.join(workdir, 'write-preview');
  mkdirSync(previewDir, { recursive: true });

  const evaluated = readJson(evaluatedPath, 'evaluated JSON');
  validateEvaluatedJson(evaluated);
  const config = readJson(configPath, 'writeback config');
  validateConfig(config);

  const fields = loadTargetFields(config.target_table);
  const fieldErrors = validateTargetFields(fields, config);

  const previewId = path.basename(evaluatedPath, '.evaluated.json');
  const outputPath = path.join(previewDir, `${previewId}.write-preview.json`);
  const items = [];
  const errors = [];

  for (const result of evaluated.results || []) {
    const matchValue = result.source_record_id || result.dedupe_key || '';
    const itemErrors = [...fieldErrors];
    const fieldsToWrite = buildFieldsToWrite(result, config.field_mapping, fields);

    const item = {
      candidate_id: result.candidate_id || null,
      unique_key: result.unique_key || null,
      application_count: result.application_count || 1,
      source_record_id: result.source_record_id || null,
      display_fields: result.display_fields || {},
      match_value: matchValue,
      operation: itemErrors.length ? 'skip' : 'create',
      record_id: null,
      fields: itemErrors.length ? {} : fieldsToWrite,
      validation: {
        status: itemErrors.length ? 'error' : 'ok',
        messages: itemErrors,
      },
    };
    items.push(item);
    if (itemErrors.length) {
      errors.push({
        candidate_id: result.candidate_id || null,
        source_record_id: result.source_record_id || null,
        messages: itemErrors,
      });
    }
  }

  const payload = {
    preview_id: previewId,
    source_file: evaluatedPath,
    created_at: nowBeijingIso(),
    target_table: {
      app_token: config.target_table.app_token,
      table_id: config.target_table.table_id,
    },
    match: {
      mode: 'create_only',
    },
    field_mapping: config.field_mapping,
    items,
    errors,
    summary: {
      total: items.length,
      create: items.filter(item => item.operation === 'create').length,
      skip: items.filter(item => item.operation === 'skip').length,
      error: items.filter(item => item.validation.status === 'error').length,
    },
  };

  writeJson(outputPath, payload);
  console.log(`[writeback] preview=${outputPath}`);
  console.log(`[writeback] total=${payload.summary.total}, create=${payload.summary.create}, skip=${payload.summary.skip}, error=${payload.summary.error}`);
}

function runApply(previewPath, workdir) {
  const config = readWritebackConfigIfPresent(workdir);
  const resultDir = path.join(workdir, 'write-result');
  mkdirSync(resultDir, { recursive: true });

  const preview = readJson(previewPath, 'write preview JSON');
  validatePreviewJson(preview);

  const validationErrors = [];
  if ((preview.errors || []).length > 0) validationErrors.push('preview.errors 非空');
  for (const item of preview.items || []) {
    if (item.validation?.status === 'error') {
      validationErrors.push(`存在 validation error: ${item.source_record_id || item.candidate_id}`);
    }
  }
  if (validationErrors.length) {
    fail(`Preview contains errors; refusing apply: ${validationErrors.slice(0, 5).join('; ')}`);
  }

  const results = [];
  const errors = [];
  for (const item of preview.items || []) {
    if (item.operation !== 'create') {
      results.push({
        candidate_id: item.candidate_id,
        source_record_id: item.source_record_id,
        operation: item.operation,
        status: 'skipped',
        message: 'operation is not create',
      });
      continue;
    }

    const res = createRecord(preview.target_table, item.fields);
    if (isLarkOk(res)) {
      results.push({
        candidate_id: item.candidate_id,
        source_record_id: item.source_record_id,
        operation: 'create',
        record_id: res.data?.record?.record_id || res.data?.record_id || null,
        status: 'created',
      });
    } else {
      const message = res?.msg || JSON.stringify(res?.error || res);
      errors.push({
        candidate_id: item.candidate_id,
        source_record_id: item.source_record_id,
        message,
      });
      results.push({
        candidate_id: item.candidate_id,
        source_record_id: item.source_record_id,
        operation: 'create',
        status: 'failed',
        message,
      });
    }
  }

  const payload = {
    preview_id: preview.preview_id,
    preview_file: previewPath,
    applied_at: nowBeijingIso(),
    results,
    errors,
    summary: {
      total: results.length,
      created: results.filter(item => item.status === 'created').length,
      skipped: results.filter(item => item.status === 'skipped').length,
      failed: results.filter(item => item.status === 'failed').length,
    },
  };

  const outputPath = path.join(resultDir, `${preview.preview_id}.write-result.json`);
  writeJson(outputPath, payload);
  sendNotification(config?.notification, buildApplyNotification(payload, outputPath, preview));
  console.log(`[writeback] result=${outputPath}`);
  console.log(`[writeback] total=${payload.summary.total}, created=${payload.summary.created}, skipped=${payload.summary.skipped}, failed=${payload.summary.failed}`);
}

function buildApplyNotification(payload, outputPath, preview) {
  const stats = summarizeEvaluationFeedback(preview);
  const channel = inferPreviewChannel(preview);
  return [
    '招聘评估写回已执行',
    `渠道：${channel}`,
    '',
    '评估结果：',
    `一共：${stats.total}`,
    `推荐：${stats.recommended}`,
    `待 HR 确认：${stats.hr_confirm}`,
    `不推荐：${stats.not_recommended}`,
    `信息不足/其他：${stats.other}`,
  ].join('\n');
}

function inferPreviewChannel(preview) {
  const labels = new Set();
  const channelField = preview.field_mapping?.channel || '来源渠道';
  for (const item of preview.items || []) {
    const value = normalizeFieldText(item.display_fields?.channel || item.fields?.[channelField]);
    if (value) labels.add(value);
  }
  if (labels.size === 1) return [...labels][0];
  if (labels.size > 1) return [...labels].join(' / ');
  const id = String(preview.preview_id || '');
  if (id.includes('feishu_hire')) return '飞书招聘';
  if (id.includes('email_resume')) return '邮箱';
  return '未知';
}

function summarizeEvaluationFeedback(preview) {
  const feedbackField = preview.field_mapping?.feedback || '简历反馈';
  const stats = {
    total: 0,
    recommended: 0,
    hr_confirm: 0,
    not_recommended: 0,
    other: 0,
  };
  for (const item of preview.items || []) {
    if (item.operation !== 'create') continue;
    stats.total += 1;
    const feedback = normalizeFieldText(item.fields?.[feedbackField]);
    if (feedback.includes('不推荐')) {
      stats.not_recommended += 1;
    } else if (feedback.includes('待HR确认') || feedback.includes('待 HR 确认')) {
      stats.hr_confirm += 1;
    } else if (feedback.includes('推荐')) {
      stats.recommended += 1;
    } else {
      stats.other += 1;
    }
  }
  return stats;
}

function sendNotification(notification, text) {
  if (!notification?.enabled) return;
  const webhookUrl = String(notification.webhook_url || '').trim();
  if (!webhookUrl || webhookUrl.includes('REPLACE_WITH')) return;

  const keyword = String(notification.keyword || '').trim();
  const content = keyword && !text.includes(keyword) ? `${keyword}\n${text}` : text;
  const res = httpJson(webhookUrl, {
    msg_type: 'text',
    content: {
      text: content,
    },
  });
  if (res.status < 200 || res.status >= 300) {
    console.error(`[writeback] notification failed: HTTP ${res.status} ${res.body.slice(0, 300)}`);
  }
}

function httpJson(url, body) {
  try {
    const raw = execFileSync('curl', [
      '-sS',
      '-X',
      'POST',
      '-H',
      'Content-Type: application/json',
      '--data',
      JSON.stringify(body),
      '-w',
      '\n%{http_code}',
      url,
    ], {
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const splitAt = raw.lastIndexOf('\n');
    if (splitAt < 0) return { body: raw, status: 0 };
    return {
      body: raw.slice(0, splitAt),
      status: Number(raw.slice(splitAt + 1)) || 0,
    };
  } catch (error) {
    return {
      body: error.stderr?.toString() || error.message,
      status: 0,
    };
  }
}

function readWritebackConfigIfPresent(workdir) {
  const configPath = path.join(workdir, 'writeback-config.json');
  if (!existsSync(configPath)) return null;
  return readJson(configPath, 'writeback config');
}

function buildFieldsToWrite(result, mapping, targetFields) {
  const evaluation = result.evaluation || {};
  const display = result.display_fields || {};
  const source = {
    score: evaluation.score,
    feedback: evaluation.feedback,
    match_points: evaluation.match_points,
    risk_points: evaluation.risk_points,
    name: display.name,
    job_name: display.job_name,
    channel: display.channel,
    received_at: display.received_at,
    city: display.city,
    application_count: result.application_count || 1,
  };

  const fields = {};
  for (const [sourceKey, targetField] of Object.entries(mapping || {})) {
    if (!targetField) continue;
    if (Object.prototype.hasOwnProperty.call(source, sourceKey)) {
      fields[targetField] = convertFieldValueForBitable(source[sourceKey] ?? null, targetFields.get(targetField));
    }
  }
  return fields;
}

function convertFieldValueForBitable(value, fieldMeta) {
  if (value == null || value === '') return null;
  if (isDateField(fieldMeta)) {
    const ts = Date.parse(value);
    if (Number.isNaN(ts)) return value;
    return ts;
  }
  return value;
}

function isDateField(fieldMeta) {
  if (!fieldMeta) return false;
  const type = String(fieldMeta.type ?? fieldMeta.ui_type ?? fieldMeta.field_type ?? '').toLowerCase();
  const uiType = String(fieldMeta.ui_type ?? '').toLowerCase();
  return type === '5' || type.includes('date') || uiType.includes('date');
}

function loadTargetFields(targetTable) {
  const res = larkCli([
    'api',
    'GET',
    `/open-apis/bitable/v1/apps/${targetTable.app_token}/tables/${targetTable.table_id}/fields`,
    '--as',
    'bot',
  ]);
  if (!isLarkOk(res)) {
    throw new Error(`无法读取目标表字段: ${res?.msg || JSON.stringify(res?.error || res)}`);
  }
  const fields = new Map();
  for (const field of res.data?.items || []) {
    if (field.field_name) fields.set(field.field_name, field);
  }
  return fields;
}

function validateTargetFields(fields, config) {
  const errors = [];
  for (const targetField of Object.values(config.field_mapping || {})) {
    if (targetField && !fields.has(targetField)) errors.push(`目标表缺少写入字段：${targetField}`);
  }
  return errors;
}

function createRecord(targetTable, fields) {
  return larkCli([
    'api',
    'POST',
    `/open-apis/bitable/v1/apps/${targetTable.app_token}/tables/${targetTable.table_id}/records`,
    '--as',
    'bot',
    '--data',
    JSON.stringify({ fields }),
  ]);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--mode') {
      args.mode = argv[++i];
    } else if (arg === '--input') {
      args.input = argv[++i];
    } else if (arg === '--workdir') {
      args.workdir = argv[++i];
    } else {
      fail(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function printUsage() {
  console.log(`Usage:
  node scripts/writeback-evaluation-results.mjs --mode preview --input workspace/evaluated/xxx.evaluated.json --workdir workspace
  node scripts/writeback-evaluation-results.mjs --mode apply --input workspace/write-preview/xxx.write-preview.json --workdir workspace`);
}

function validateEvaluatedJson(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.results)) {
    fail('Input is not a valid evaluated JSON: missing results array.');
  }
}

function validatePreviewJson(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.items) || !data.target_table) {
    fail('Input is not a valid write-preview JSON.');
  }
}

function validateConfig(config) {
  const missing = [];
  if (!config?.target_table?.app_token) missing.push('target_table.app_token');
  if (!config?.target_table?.table_id) missing.push('target_table.table_id');
  if (!config?.field_mapping || Object.keys(config.field_mapping).length === 0) missing.push('field_mapping');
  if (missing.length) fail(`Writeback config missing: ${missing.join(', ')}`);
}

function larkCli(args) {
  try {
    const raw = execFileSync('lark-cli', args, {
      encoding: 'utf8',
      timeout: 60000,
      maxBuffer: 20 * 1024 * 1024,
    });
    return parseJsonFromCli(raw);
  } catch (error) {
    const stdout = error.stdout?.toString() || '';
    if (stdout) {
      try {
        return parseJsonFromCli(stdout);
      } catch {
        // fall through
      }
    }
    return {
      code: -1,
      msg: error.stderr?.toString()?.slice(0, 500) || error.message,
    };
  }
}

function parseJsonFromCli(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const lines = trimmed.split('\n');
    const jsonStart = lines.findIndex(line => line.startsWith('{') || line.startsWith('['));
    if (jsonStart < 0) return null;
    return JSON.parse(lines.slice(jsonStart).join('\n'));
  }
}

function isLarkOk(res) {
  return res?.code === 0 || res?.ok === true;
}

function normalizeFieldText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    return value.map(normalizeFieldText).filter(Boolean).join('\n').trim();
  }
  if (typeof value === 'object') {
    if (value.text) return String(value.text).trim();
    if (value.name) return normalizeFieldText(value.name);
    return JSON.stringify(value);
  }
  return String(value).trim();
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
  console.error(`[writeback] ${message}`);
  process.exit(1);
}

function nowBeijingIso() {
  const beijingMs = Date.now() + 8 * 60 * 60 * 1000;
  return `${new Date(beijingMs).toISOString().slice(0, 19)}+08:00`;
}
