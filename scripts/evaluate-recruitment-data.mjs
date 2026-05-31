#!/usr/bin/env node

import { execFileSync } from 'child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import path from 'path';

const DEFAULT_MAX_PROMPT_CHARS = 16000;

main();

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }
  if (!args.input) fail('Missing --input.');
  if (!args.workdir) fail('Missing --workdir.');

  const workdir = path.resolve(args.workdir);
  const inputPath = path.resolve(args.input);
  const configPath = path.join(workdir, 'evaluator-config.json');
  const evaluatedDir = path.join(workdir, 'evaluated');
  mkdirSync(evaluatedDir, { recursive: true });

  const inputBase = path.basename(inputPath, '.json');
  const outputPath = path.join(evaluatedDir, `${inputBase}.evaluated.json`);
  const statePath = path.join(evaluatedDir, `${inputBase}.evaluation-state.json`);
  const lockPath = path.join(evaluatedDir, `${inputBase}.evaluation.lock`);

  if (existsSync(lockPath)) {
    fail(`Current input is already being evaluated. Lock exists: ${lockPath}`);
  }

  const existingState = loadJsonIfExists(statePath);
  if (existingState?.status === 'in_progress') {
    fail(`Current input is already marked in_progress: ${statePath}`);
  }
  if (existingState?.status === 'completed' && existsSync(outputPath)) {
    console.log(`[evaluator] already completed: ${outputPath}`);
    return;
  }

  const collected = readJson(inputPath, 'input collected JSON');
  validateCollectedJson(collected);
  const config = readJson(configPath, 'evaluator config');
  validateConfig(config);

  const now = nowBeijingIso();
  writeJson(lockPath, {
    input_file: inputPath,
    created_at: now,
  });

  const state = {
    run_id: collected.run_id,
    input_file: inputPath,
    output_file: outputPath,
    status: 'in_progress',
    total: collected.candidates.length,
    completed: 0,
    failed: 0,
    updated_at: now,
  };
  writeJson(statePath, state);

  try {
    const criteriaMap = loadCriteriaMap(config.criteria_table);
    const results = [];
    const errors = [];
    const evaluatedAt = nowBeijingIso();
    const maxPromptChars = config.evaluation?.max_prompt_chars || DEFAULT_MAX_PROMPT_CHARS;
    const concurrency = normalizeConcurrency(config.evaluation?.concurrency);

    await runEvaluations({
      candidates: collected.candidates,
      criteriaMap,
      config,
      maxPromptChars,
      concurrency,
      results,
      errors,
      state,
      statePath,
    });

    const payload = {
      run_id: collected.run_id,
      source_file: inputPath,
      channel: collected.channel,
      evaluated_at: evaluatedAt,
      results,
      errors,
      summary: {
        total: results.length,
        completed: results.filter(item => item.status === 'completed').length,
        failed: results.filter(item => item.status === 'failed').length,
        information_insufficient: results.filter(item => item.evaluation?.score === 0).length,
      },
    };

    writeJson(outputPath, payload);
    state.status = 'completed';
    state.updated_at = nowBeijingIso();
    writeJson(statePath, state);
    rmSync(lockPath, { force: true });

    console.log(`[evaluator] output=${outputPath}`);
    console.log(`[evaluator] total=${payload.summary.total}, completed=${payload.summary.completed}, failed=${payload.summary.failed}, information_insufficient=${payload.summary.information_insufficient}`);
  } catch (error) {
    state.status = 'failed';
    state.error = error.message;
    state.updated_at = nowBeijingIso();
    writeJson(statePath, state);
    throw error;
  }
}

async function runEvaluations({ candidates, criteriaMap, config, maxPromptChars, concurrency, results, errors, state, statePath }) {
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < candidates.length) {
      const index = nextIndex;
      nextIndex += 1;
      const candidate = candidates[index];
      const result = await evaluateCandidate(candidate, criteriaMap, config, maxPromptChars);
      results[index] = result;

      if (result.status === 'completed') state.completed += 1;
      else state.failed += 1;
      if (result.error) {
        errors.push({
          candidate_id: candidate.candidate_id,
          source_record_id: candidate.source_record_id,
          error: result.error,
        });
      }
      state.updated_at = nowBeijingIso();
      writeJson(statePath, state);
    }
  }

  const workerCount = Math.min(concurrency, candidates.length || 1);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}

function normalizeConcurrency(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return Math.min(parsed, 10);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
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
  node scripts/evaluate-recruitment-data.mjs --input workspace/collected/xxx.json --workdir workspace`);
}

function fail(message) {
  console.error(`[evaluator] ${message}`);
  process.exit(1);
}

function validateCollectedJson(data) {
  if (!data || typeof data !== 'object') fail('Input is not a JSON object.');
  if (!data.run_id || !data.channel || !Array.isArray(data.candidates)) {
    fail('Input is not a valid collected JSON: missing run_id, channel, or candidates.');
  }
}

function validateConfig(config) {
  const missing = [];
  if (!config?.model?.base_url) missing.push('model.base_url');
  if (!config?.model?.api_key) missing.push('model.api_key');
  if (!config?.model?.model) missing.push('model.model');
  if (!config?.criteria_table?.app_token) missing.push('criteria_table.app_token');
  if (!config?.criteria_table?.table_id) missing.push('criteria_table.table_id');
  if (missing.length) fail(`Evaluator config missing: ${missing.join(', ')}`);
}

function loadCriteriaMap(criteriaConfig) {
  const jobField = criteriaConfig.job_name_field || '岗位名称';
  const promptField = criteriaConfig.prompt_field || '评估提示词';
  const records = [];
  let pageToken = '';
  let hasMore = true;

  while (hasMore) {
    const params = {
      page_size: 100,
    };
    if (pageToken) params.page_token = pageToken;

    const res = larkCli([
      'api',
      'POST',
      `/open-apis/bitable/v1/apps/${criteriaConfig.app_token}/tables/${criteriaConfig.table_id}/records/search`,
      '--as',
      'bot',
      '--data',
      JSON.stringify(params),
    ]);
    if (!isLarkOk(res)) {
      throw new Error(`无法读取评估标准表: ${res?.msg || JSON.stringify(res?.error || res)}`);
    }

    for (const item of res.data?.items || []) {
      const fields = item.fields || {};
      const jobName = normalizeFieldText(fields[jobField]);
      const prompt = normalizeFieldText(fields[promptField]);
      if (!jobName || !prompt) continue;
      records.push({
        criteria_id: item.record_id || null,
        criteria_name: jobName,
        job_name: jobName,
        prompt,
      });
    }

    hasMore = Boolean(res.data?.has_more);
    pageToken = res.data?.page_token || '';
  }

  const map = new Map();
  for (const record of records) {
    if (!map.has(record.job_name)) map.set(record.job_name, []);
    map.get(record.job_name).push(record);
  }
  return map;
}

async function evaluateCandidate(candidate, criteriaMap, config, maxPromptChars) {
  const evaluatedAt = nowBeijingIso();
  const jobName = candidate.job_name || candidate.eval_input?.position || null;
  const criteriaMatches = jobName ? criteriaMap.get(jobName) || [] : [];

  if (!jobName) {
    return buildInformationInsufficient(candidate, {
      evaluatedAt,
      error: '没有岗位名称，无法匹配对应的 skill',
      criteria: { criteria_id: null, criteria_name: null, matched_by: 'none' },
    });
  }

  if (criteriaMatches.length === 0) {
    return buildInformationInsufficient(candidate, {
      evaluatedAt,
      error: '没有查到对应的 skill',
      criteria: { criteria_id: null, criteria_name: null, matched_by: 'none' },
    });
  }

  if (criteriaMatches.length > 1) {
    return buildInformationInsufficient(candidate, {
      evaluatedAt,
      error: '查到多个对应的 skill',
      criteria: { criteria_id: null, criteria_name: jobName, matched_by: 'job_name' },
    });
  }

  const criteria = criteriaMatches[0];
  const promptResult = buildPrompt(candidate, criteria.prompt, maxPromptChars);
  const rawOutput = await callModel(config.model, promptResult.prompt);
  const parsed = parseModelEvaluation(rawOutput);

  if (!parsed.ok) {
    return {
      ...baseResult(candidate, evaluatedAt),
      criteria: {
        criteria_id: criteria.criteria_id,
        criteria_name: criteria.criteria_name,
        matched_by: 'job_name',
      },
      prompt: promptResult.prompt,
      prompt_truncated: promptResult.truncated,
      model_raw_output: rawOutput,
      evaluation: {
        score: 0,
        feedback: feedbackFromScore(0),
        match_points: '',
        risk_points: '无法评估：模型输出格式错误',
      },
      model: {
        provider: 'openai-compatible',
        model: config.model.model,
        attempts: 1,
      },
      status: 'failed',
      error: parsed.error,
    };
  }

  return {
    ...baseResult(candidate, evaluatedAt),
    criteria: {
      criteria_id: criteria.criteria_id,
      criteria_name: criteria.criteria_name,
      matched_by: 'job_name',
    },
    prompt: promptResult.prompt,
    prompt_truncated: promptResult.truncated,
    model_raw_output: rawOutput,
    evaluation: parsed.value,
    model: {
      provider: 'openai-compatible',
      model: config.model.model,
      attempts: 1,
    },
    status: 'completed',
    error: null,
  };
}

function buildInformationInsufficient(candidate, { evaluatedAt, error, criteria }) {
  return {
    ...baseResult(candidate, evaluatedAt),
    criteria,
    prompt: null,
    prompt_truncated: false,
    model_raw_output: null,
    evaluation: {
      score: 0,
      feedback: feedbackFromScore(0),
      match_points: '',
      risk_points: `无法评估：${error}`,
    },
    model: {
      provider: 'openai-compatible',
      model: null,
      attempts: 0,
    },
    status: 'failed',
    error,
  };
}

function baseResult(candidate, evaluatedAt) {
  return {
    candidate_id: candidate.candidate_id,
    unique_key: candidate.unique_key || null,
    application_count: candidate.application_count || 1,
    source_record_id: candidate.source_record_id,
    dedupe_key: candidate.dedupe_key,
    channel: candidate.channel,
    job_id: candidate.job_id || null,
    job_name: candidate.job_name || candidate.eval_input?.position || null,
    display_fields: buildEvaluatedDisplayFields(candidate),
    evaluated_at: evaluatedAt,
  };
}

function buildEvaluatedDisplayFields(candidate) {
  const display = candidate.display_fields || {};
  const input = candidate.eval_input || {};
  const channelName = candidate.channel === 'feishu_hire'
    ? '飞书招聘'
    : candidate.channel === 'email_resume'
      ? '邮箱'
      : candidate.channel || '';

  if (candidate.channel === 'feishu_hire') {
    return {
      name: display.name || input.name || null,
      job_name: candidate.job_name || display.job_name || input.position || null,
      channel: channelName,
      received_at: display.applied_at || null,
      city: display.city || input.city || null,
    };
  }

  if (candidate.channel === 'email_resume') {
    return {
      name: display.name || input.name || null,
      job_name: candidate.job_name || display.job_name || input.position || null,
      channel: channelName,
      received_at: display.received_at || null,
      city: display.city || null,
    };
  }

  return {
    name: display.name || input.name || null,
    job_name: candidate.job_name || display.job_name || input.position || null,
    channel: channelName,
    received_at: display.received_at || display.applied_at || null,
    city: display.city || input.city || null,
  };
}

function buildPrompt(candidate, criteriaPrompt, maxPromptChars) {
  const candidateText = buildCandidateProfile(candidate);
  const start = `你是招聘简历评估助手。请只基于输入的候选人信息和岗位评估标准做判断，不要编造简历中没有的信息，不要推断敏感个人属性。

你的任务是判断该候选人是否适合进入面试，并给出适合 HR 阅读的简洁理由。`;
  const end = `请只输出 JSON，不要输出 Markdown，不要输出解释性前后缀。

JSON 格式必须是：
{
  "score": 1-10 的整数；无法判断时为 0,
  "match_points": "string",
  "risk_points": "string"
}

评分规则：
- 8-10分：强匹配，推荐面试
- 6-7分：基本匹配，推荐面试
- 4-5分：部分匹配，待 HR 确认
- 1-3分：不匹配，不推荐
- 0分：信息不足，无法判断`;
  let prompt = `${start}

【候选人信息】
${candidateText}

【岗位评估标准】
${criteriaPrompt}

${end}`;

  let truncated = false;
  if (prompt.length > maxPromptChars) {
    truncated = true;
    const fixedLength = prompt.length - candidateText.length;
    const allowedCandidateLength = Math.max(1000, maxPromptChars - fixedLength - 200);
    const truncatedCandidate = `${candidateText.slice(0, allowedCandidateLength)}

【候选人信息已因长度限制截断】`;
    prompt = `${start}

【候选人信息】
${truncatedCandidate}

【岗位评估标准】
${criteriaPrompt}

${end}`;
    if (prompt.length > maxPromptChars) {
      prompt = prompt.slice(0, maxPromptChars);
    }
  }

  return { prompt, truncated };
}

function buildCandidateProfile(candidate) {
  if (candidate.channel === 'feishu_hire') return buildFeishuHireProfile(candidate);
  if (candidate.channel === 'email_resume') return buildEmailResumeProfile(candidate);
  return buildGenericProfile(candidate);
}

function buildFeishuHireProfile(candidate) {
  const input = candidate.eval_input || {};
  const display = candidate.display_fields || {};
  return [
    `来源渠道：飞书招聘`,
    `业务唯一键：${candidate.unique_key || ''}`,
    `投递次数：${candidate.application_count || 1}`,
    `姓名：${input.name || display.name || ''}`,
    `应聘岗位：${candidate.job_name || input.position || ''}`,
    `当前阶段：${input.stage || display.application_stage || ''}`,
    `城市：${input.city || display.city || ''}`,
    `来源：${input.source_channel || display.source || ''}`,
    `学历：${input.degree || display.degree || ''}`,
    `工作年限：${input.experience_years ?? display.experience_years ?? ''}`,
    `工作经历摘要：${input.career_summary || ''}`,
    `教育经历摘要：${input.education_summary || ''}`,
    `项目经历摘要：${input.project_summary || ''}`,
    `作品摘要：${input.works_summary || ''}`,
    `自我评价：${input.self_evaluation || ''}`,
    `职位描述：${input.job_description || ''}`,
    `工作经历明细：${stringifyForPrompt(input.career_list || [])}`,
    `教育经历明细：${stringifyForPrompt(input.education_list || [])}`,
    `项目经历明细：${stringifyForPrompt(input.project_list || [])}`,
    `作品明细：${stringifyForPrompt(input.works_list || [])}`,
    `获奖经历：${stringifyForPrompt(input.award_list || [])}`,
    `语言能力：${stringifyForPrompt(input.language_list || [])}`,
    `社交账号：${stringifyForPrompt(input.sns_list || [])}`,
  ].join('\n');
}

function buildEmailResumeProfile(candidate) {
  const input = candidate.eval_input || {};
  const display = candidate.display_fields || {};
  return [
    `来源渠道：邮箱简历`,
    `业务唯一键：${candidate.unique_key || ''}`,
    `投递次数：${candidate.application_count || 1}`,
    `姓名：${input.name || display.name || ''}`,
    `应聘岗位：${candidate.job_name || input.position || display.job_name || ''}`,
    `城市：${display.city || ''}`,
    `学历：${input.degree || display.degree || ''}`,
    `工作年限：${input.work_years ?? display.work_years ?? ''}`,
    `期望薪资：${display.salary || ''}`,
    `电话：${display.phone || ''}`,
    `邮箱：${display.email || ''}`,
    `邮件主题：${input.email_subject || display.subject || ''}`,
    `邮件正文：${input.email_body || ''}`,
    `附件：${stringifyForPrompt(input.attachments || [])}`,
    `经历摘要：${input.experience || ''}`,
    `职位描述：${input.job_description || ''}`,
    `简历正文：\n${cleanResumeText(input.resume_text || '')}`,
  ].join('\n');
}

function buildGenericProfile(candidate) {
  return [
    `来源渠道：${candidate.channel || ''}`,
    `业务唯一键：${candidate.unique_key || ''}`,
    `投递次数：${candidate.application_count || 1}`,
    `应聘岗位：${candidate.job_name || candidate.eval_input?.position || ''}`,
    `候选人信息：${stringifyForPrompt(candidate.eval_input || {})}`,
  ].join('\n');
}

function stringifyForPrompt(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length === 0) return '';
  return JSON.stringify(value, null, 2);
}

function cleanResumeText(text) {
  return String(text || '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function callModel(modelConfig, prompt) {
  const url = joinUrl(modelConfig.base_url, '/chat/completions');
  const body = {
    model: modelConfig.model,
    messages: [
      { role: 'user', content: prompt },
    ],
    temperature: 0.2,
    top_p: 1,
    extra_body: {
      enable_thinking: modelConfig.enable_thinking ?? false,
      ...(modelConfig.extra_options || {}),
    },
    response_format: { type: 'json_object' },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${modelConfig.api_key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`模型 API 调用失败: HTTP ${res.status} ${text.slice(0, 500)}`);
  }

  const data = JSON.parse(text);
  return data.choices?.[0]?.message?.content || '';
}

function parseModelEvaluation(rawOutput) {
  try {
    const value = JSON.parse(extractJson(rawOutput));
    const missing = ['score', 'match_points', 'risk_points'].filter(key => value[key] == null);
    if (missing.length) return { ok: false, error: `模型输出缺字段: ${missing.join(', ')}` };
    const score = Number(value.score);
    if (!Number.isInteger(score) || score < 0 || score > 10) return { ok: false, error: `score 非法: ${value.score}` };
    return {
      ok: true,
      value: {
        score,
        feedback: feedbackFromScore(score),
        match_points: String(value.match_points || ''),
        risk_points: String(value.risk_points || ''),
      },
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function feedbackFromScore(score) {
  if (score >= 6) return '推荐面试';
  if (score >= 4) return '待HR确认';
  if (score >= 1) return '不推荐';
  return '信息不足';
}

function extractJson(text) {
  const trimmed = String(text || '').trim();
  if (trimmed.startsWith('{')) return trimmed;
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  throw new Error('模型输出不是 JSON');
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

function readJson(filePath, label) {
  if (!existsSync(filePath)) fail(`${label} not found: ${filePath}`);
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    fail(`Cannot parse ${label}: ${filePath}: ${error.message}`);
  }
}

function loadJsonIfExists(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(filePath, data) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function joinUrl(baseUrl, suffix) {
  return `${baseUrl.replace(/\/+$/, '')}${suffix}`;
}

function nowBeijingIso() {
  const beijingMs = Date.now() + 8 * 60 * 60 * 1000;
  return `${new Date(beijingMs).toISOString().slice(0, 19)}+08:00`;
}
