#!/usr/bin/env node

import { execFileSync, execSync } from 'child_process';
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

const CHANNELS = new Set(['feishu_hire', 'email_resume']);
const MAILBOX = 'HRjianli@zhiwai.top';
const EMAIL_WORK_DIR = '/tmp/zhiwai-resume-email-collector';
const BUNDLED_PYTHON = '/Users/guan/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3';

const TOP_DEGREE_MAP = { 1: '小学', 2: '初中', 3: '专职', 4: '高中', 5: '大专', 6: '本科', 7: '硕士', 8: '博士' };
const FIRST_DEGREE_MAP = { 1: '低于大专', 2: '大专', 3: '本科', 4: '硕士', 5: '博士' };

main();

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  if (!CHANNELS.has(args.channel)) {
    fail('Missing or invalid --channel. Expected feishu_hire or email_resume.');
  }
  if (!args.workdir) {
    fail('Missing --workdir.');
  }

  const workdir = path.resolve(args.workdir);
  const collectedDir = path.join(workdir, 'collected');
  const statePath = path.join(workdir, 'runtime-state.json');
  mkdirSync(collectedDir, { recursive: true });
  const lockPath = path.join(collectedDir, `${args.channel}.collection.lock`);
  acquireLock(lockPath, {
    type: 'collection',
    channel: args.channel,
    workdir,
    created_at: nowBeijingIso(),
  });

  try {
    const end = nowBeijing();
    const state = loadState(statePath);
    const lastSuccess = state.collection?.[args.channel]?.last_success_at || null;
    const start = lastSuccess ? new Date(lastSuccess) : new Date(end.getTime() - 60 * 60 * 1000);
    const runId = `${formatBeijingForFile(end)}_${args.channel}`;
    const outputPath = nextOutputPath(path.join(collectedDir, `${runId}.json`));

    console.log(`[collector] channel=${args.channel}`);
    console.log(`[collector] workdir=${workdir}`);
    console.log(`[collector] window=${toBeijingIso(start)} -> ${toBeijingIso(end)}`);

    const errors = [];
    let fetched = [];

    const collectedAt = toBeijingIso(end);
    if (args.channel === 'feishu_hire') {
      fetched = collectFeishuHire(start, end, errors);
    } else {
      fetched = collectEmailResumes(start, end, errors, collectedAt);
    }

    const { candidates, duplicates } = mergeCandidatesByUniqueKey(fetched);
    const payload = {
      run_id: path.basename(outputPath, '.json'),
      channel: args.channel,
      collected_at: collectedAt,
      time_range: {
        start: toBeijingIso(start),
        end: toBeijingIso(end),
      },
      candidates,
      duplicates,
      errors,
      summary: {
        total_fetched: fetched.length,
        total: candidates.length,
        duplicate: duplicates.length,
        failed: errors.length,
      },
    };

    writeJson(outputPath, payload);
    const hasFatalError = errors.some(error => error.fatal);
    if (!hasFatalError) {
      updateState(statePath, state, args.channel, toBeijingIso(end), outputPath);
    }

    console.log(`[collector] output=${outputPath}`);
    console.log(`[collector] candidates=${candidates.length}, duplicates=${duplicates.length}, errors=${errors.length}`);
    if (hasFatalError) {
      console.error('[collector] fatal source error; runtime-state.json was not updated');
      process.exitCode = 1;
    }
  } finally {
    releaseLock(lockPath);
  }
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--channel') {
      args.channel = argv[++i];
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
  node scripts/collect-recruitment-data.mjs --channel feishu_hire --workdir workspace
  node scripts/collect-recruitment-data.mjs --channel email_resume --workdir workspace`);
}

function fail(message) {
  console.error(`[collector] ${message}`);
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
      fail(`Collection is already running. Lock exists: ${lockPath}`);
    }
    throw error;
  }
}

function releaseLock(lockPath) {
  rmSync(lockPath, { force: true });
}

function loadState(statePath) {
  if (!existsSync(statePath)) return { collection: {} };
  try {
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    if (!state.collection) state.collection = {};
    return state;
  } catch (error) {
    fail(`Cannot parse state file ${statePath}: ${error.message}`);
  }
}

function updateState(statePath, state, channel, endIso, outputPath) {
  if (!state.collection) state.collection = {};
  if (!state.collection[channel]) state.collection[channel] = {};
  state.collection[channel].last_success_at = endIso;
  state.collection[channel].last_output_file = outputPath;
  state.collection[channel].updated_at = endIso;
  mkdirSync(path.dirname(statePath), { recursive: true });
  writeJson(statePath, state);
}

function writeJson(filePath, data) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function nextOutputPath(basePath) {
  if (!existsSync(basePath)) return basePath;
  const ext = path.extname(basePath);
  const stem = basePath.slice(0, -ext.length);
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${stem}_${i}${ext}`;
    if (!existsSync(candidate)) return candidate;
  }
  fail(`Too many output files with same timestamp near ${basePath}`);
}

function mergeCandidatesByUniqueKey(fetched) {
  const seen = new Set();
  const byUniqueKey = new Map();
  const candidates = [];
  const duplicates = [];

  for (const candidate of fetched) {
    const dedupeKey = candidate.dedupe_key;
    if (!dedupeKey) {
      duplicates.push({
        reason: 'missing_dedupe_key',
        candidate,
      });
      continue;
    }
    if (seen.has(dedupeKey)) {
      duplicates.push({
        reason: 'duplicate_in_current_run',
        dedupe_key: dedupeKey,
        source_record_id: candidate.source_record_id,
      });
      continue;
    }

    seen.add(dedupeKey);
    const uniqueKey = candidate.unique_key;
    if (!uniqueKey) {
      duplicates.push({
        reason: 'missing_unique_key',
        dedupe_key: dedupeKey,
        source_record_id: candidate.source_record_id,
      });
      continue;
    }

    if (byUniqueKey.has(uniqueKey)) {
      mergeDuplicateCandidate(byUniqueKey.get(uniqueKey), candidate);
      continue;
    }

    candidate.application_count = candidate.application_count || 1;
    ensureRawRefArray(candidate.raw_refs, 'source_record_ids', candidate.source_record_id);
    if (candidate.channel === 'feishu_hire') {
      ensureRawRefArray(candidate.raw_refs, 'application_ids', candidate.application_id);
    } else if (candidate.channel === 'email_resume') {
      ensureRawRefArray(candidate.raw_refs, 'message_attachment_ids', candidate.source_record_id);
    }
    byUniqueKey.set(uniqueKey, candidate);
    candidates.push(candidate);
  }

  return { candidates, duplicates };
}

function mergeDuplicateCandidate(target, incoming) {
  target.application_count = (target.application_count || 1) + 1;
  ensureRawRefArray(target.raw_refs, 'source_record_ids', incoming.source_record_id);
  if (incoming.channel === 'feishu_hire') {
    ensureRawRefArray(target.raw_refs, 'application_ids', incoming.application_id);
  } else if (incoming.channel === 'email_resume') {
    ensureRawRefArray(target.raw_refs, 'message_attachment_ids', incoming.source_record_id);
  }
}

function ensureRawRefArray(rawRefs, key, value) {
  if (!rawRefs || !value) return;
  if (!Array.isArray(rawRefs[key])) rawRefs[key] = [];
  if (!rawRefs[key].includes(value)) rawRefs[key].push(value);
}

function collectFeishuHire(start, end, errors) {
  const startMs = start.getTime();
  const endMs = end.getTime();
  const allApps = [];
  let pageToken = '';
  let hasMore = true;

  while (hasMore) {
    const params = {
      page_size: 200,
      update_start_time: String(startMs),
      update_end_time: String(endMs),
    };
    if (pageToken) params.page_token = pageToken;

    const listRes = larkCli(['api', 'GET', '/open-apis/hire/v1/applications', '--as', 'bot', '--params', JSON.stringify(params)]);
    if (!isLarkOk(listRes)) {
      errors.push({ stage: 'feishu_hire_list', fatal: true, message: listRes?.msg || 'list failed', response: compactResponse(listRes) });
      break;
    }

    const ids = listRes.data?.items || [];
    hasMore = Boolean(listRes.data?.has_more);
    pageToken = listRes.data?.page_token || '';

    for (const appId of ids) {
      const detail = larkCli(['api', 'GET', `/open-apis/hire/v1/applications/${appId}`, '--as', 'bot']);
      if (!isLarkOk(detail) || !detail.data?.application) {
        errors.push({ stage: 'feishu_hire_application_detail', application_id: appId, message: detail?.msg || 'detail failed' });
        continue;
      }
      const app = detail.data.application;
      const createTime = normalizeEpochMs(app.create_time);
      if (createTime >= startMs && createTime <= endMs) {
        allApps.push(app);
      }
      sleep(100);
    }
    sleep(200);
  }

  const talents = new Map();
  const jobs = new Map();

  for (const talentId of unique(allApps.map(app => app.talent_id).filter(Boolean))) {
    const res = larkCli(['api', 'GET', `/open-apis/hire/v1/talents/${talentId}`, '--as', 'bot']);
    if (isLarkOk(res) && res.data?.talent) {
      talents.set(talentId, normalizeTalent(res.data.talent));
    } else {
      errors.push({ stage: 'feishu_hire_talent_detail', talent_id: talentId, message: res?.msg || 'talent detail failed' });
      talents.set(talentId, normalizeTalent(null));
    }
    sleep(100);
  }

  for (const jobId of unique(allApps.map(app => app.job_id).filter(Boolean))) {
    const res = larkCli(['api', 'GET', `/open-apis/hire/v1/jobs/${jobId}`, '--as', 'bot']);
    if (isLarkOk(res) && res.data?.job) {
      jobs.set(jobId, normalizeJob(res.data.job, jobId));
    } else {
      errors.push({ stage: 'feishu_hire_job_detail', job_id: jobId, message: res?.msg || 'job detail failed' });
      jobs.set(jobId, normalizeJob(null, jobId));
    }
    sleep(120);
  }

  const collectedAt = toBeijingIso(end);
  return allApps.map(app => {
    const talent = talents.get(app.talent_id) || normalizeTalent(null);
    const job = jobs.get(app.job_id) || normalizeJob(null, app.job_id);
    const appTime = normalizeEpochMs(app.create_time);
    const source = mapSource(app.resume_source_info);
    const city = mapHireCity(app, talent, job);
    const careerSummary = buildCareerSummary(talent.raw);
    const educationSummary = buildEducationSummary(talent.raw);
    const projectSummary = buildProjectSummary(talent.raw);
    const worksSummary = buildWorksSummary(talent.raw);
    const applicationId = app.id || app.application_id;
    const dedupeKey = applicationId || [app.talent_id, app.job_id].filter(Boolean).join(':');

    return {
      unique_key: buildUniqueKey('feishu_hire', app.talent_id || applicationId, job.name || null),
      application_count: 1,
      candidate_id: app.talent_id || applicationId,
      channel: 'feishu_hire',
      source_record_id: applicationId,
      dedupe_key: dedupeKey,
      job_id: app.job_id || null,
      job_name: job.name || null,
      application_id: applicationId || null,
      display_fields: {
        name: talent.name || null,
        phone: talent.phone || null,
        email: talent.email || null,
        job_name: job.name || null,
        application_stage: app.stage?.zh_name || null,
        applied_at: appTime ? toBeijingIso(new Date(appTime)) : null,
        source,
        city,
        degree: talent.degree || null,
        experience_years: talent.experience_years ?? null,
        career_summary: careerSummary,
        education_summary: educationSummary,
        project_summary: projectSummary,
      },
      eval_input: {
        name: talent.name || null,
        position: job.name || null,
        stage: app.stage?.zh_name || null,
        degree: talent.degree || null,
        experience_years: talent.experience_years ?? null,
        career_summary: careerSummary,
        education_summary: educationSummary,
        project_summary: projectSummary,
        works_summary: worksSummary,
        career_list: talent.career_list || [],
        education_list: talent.education_list || [],
        project_list: talent.project_list || [],
        works_list: talent.works_list || [],
        award_list: talent.award_list || [],
        language_list: talent.language_list || [],
        sns_list: talent.sns_list || [],
        self_evaluation: talent.self_evaluation || null,
        source_channel: source,
        city,
        hire_link: applicationId ? `https://ilovezhiwai.feishu.cn/hire/candidate/application/${applicationId}` : null,
        job_description: job.description || null,
      },
      raw_refs: {
        application_id: applicationId || null,
        talent_id: app.talent_id || null,
        job_id: app.job_id || null,
        resume_attachment_id_list: talent.resume_attachment_id_list || [],
      },
      collected_at: collectedAt,
    };
  });
}

function collectEmailResumes(start, end, errors, collectedAt) {
  mkdirSync(EMAIL_WORK_DIR, { recursive: true });
  const startMs = start.getTime();
  const endMs = end.getTime();
  const bossEmails = listEmailMessagesInWindow(startMs, endMs, errors);
  const collected = [];
  for (const mail of bossEmails) {
    const d = mail.detail;
    const receivedMs = normalizeEpochMs(d.internal_date || mail.internal_date || mail.date);
    if (receivedMs && (receivedMs < startMs || receivedMs > endMs)) continue;

    const emlAttachments = (d.attachments || []).filter(a => a.filename?.endsWith('.eml') && /BOSS|直聘|boss/.test(a.filename));
    if (!emlAttachments.length) continue;

    const attachmentIds = emlAttachments.map(a => a.id);
    const urlRes = larkCli(['mail', 'user_mailbox.message.attachments', 'download_url', '--params', JSON.stringify({
      user_mailbox_id: MAILBOX,
      message_id: mail.message_id,
      attachment_ids: attachmentIds,
    })]);
    const urlMap = {};
    for (const item of urlRes?.data?.download_urls || []) {
      urlMap[item.attachment_id] = item.download_url;
    }

    const attachment = emlAttachments[0];
    const parsed = parseFilename(attachment.filename || '');
    const resume = extractResumeFromEml(urlMap[attachment.id], parsed.name || 'resume', errors);
    const messagePrefix = String(d.smtp_message_id || mail.message_id).replace(/@.*/, '').slice(0, 8);
    const candidateId = `MAIL-${messagePrefix}-1`;
    const dedupeKey = `${mail.message_id}:${attachment.id}`;
    const resolvedJobName = mapPosition(parsed.position);
    const resolvedName = resume.parsed.realName || parsed.name || null;

    collected.push({
      unique_key: buildUniqueKey('email_resume', resolvedJobName, resolvedName || dedupeKey),
      application_count: 1,
      candidate_id: candidateId,
      channel: 'email_resume',
      source_record_id: `${mail.message_id}:${attachment.id}`,
      dedupe_key: dedupeKey,
      job_id: null,
      job_name: resolvedJobName,
      application_id: null,
      display_fields: {
        sender: d.head_from?.name || d.head_from?.email || null,
        subject: mail.subject || null,
        received_at: receivedMs ? toBeijingIso(new Date(receivedMs)) : null,
        attachment_names: [attachment.filename],
        job_name: resolvedJobName,
        name: resolvedName,
        phone: resume.parsed.phone || null,
        email: resume.parsed.email || null,
        city: mapCity(parsed.city),
        salary: parsed.salary || null,
        work_years: parsed.workYears ?? resume.parsed.workYears ?? null,
        degree: resume.parsed.degree || null,
      },
      eval_input: {
        name: resolvedName,
        position: resolvedJobName,
        resume_text: resume.text || '',
        email_subject: mail.subject || null,
        email_body: d.body || d.snippet || null,
        attachments: [{ id: attachment.id, filename: attachment.filename }],
        degree: resume.parsed.degree || null,
        experience: resume.parsed.experience || null,
        work_years: parsed.workYears ?? resume.parsed.workYears ?? null,
        job_description: null,
      },
      raw_refs: {
        mailbox_id: MAILBOX,
        message_id: mail.message_id,
        attachment_ids: [attachment.id],
        skipped_attachment_ids: emlAttachments.slice(1).map(item => item.id),
      },
      collected_at: collectedAt,
    });
  }

  return collected;
}

function listEmailMessagesInWindow(startMs, endMs, errors) {
  const messages = [];
  let pageToken = '';
  let hasMore = true;
  let reachedBeforeStart = false;

  while (hasMore && !reachedBeforeStart) {
    const params = {
      folder_id: 'INBOX',
      page_size: 20,
    };
    if (pageToken) params.page_token = pageToken;

    const listRes = larkCli(['api', 'GET', `/open-apis/mail/v1/user_mailboxes/${encodeURIComponent(MAILBOX)}/messages`, '--as', 'bot', '--params', JSON.stringify(params)]);
    if (!isLarkOk(listRes)) {
      errors.push({ stage: 'email_message_list', fatal: true, message: listRes?.msg || 'mail message list failed', response: compactResponse(listRes) });
      return [];
    }

    const ids = listRes.data?.items || [];
    hasMore = Boolean(listRes.data?.has_more);
    pageToken = listRes.data?.page_token || '';

    for (const messageId of ids) {
      const detail = larkCli(['mail', '+message', '--mailbox', MAILBOX, '--message-id', messageId, '--format', 'json']);
      if (!detail?.data) {
        errors.push({ stage: 'email_message_detail', message_id: messageId, message: 'message detail failed' });
        continue;
      }

      const d = detail.data;
      const receivedMs = normalizeEpochMs(d.internal_date || d.received_at || d.date);
      if (receivedMs && receivedMs > endMs) continue;
      if (receivedMs && receivedMs < startMs) {
        reachedBeforeStart = true;
        continue;
      }

      const subject = d.subject || '';
      if (/BOSS|直聘|boss/.test(subject)) {
        messages.push({
          message_id: messageId,
          subject,
          internal_date: d.internal_date || d.received_at || d.date || null,
          detail: d,
        });
      }
      sleep(100);
    }
    sleep(200);
  }

  return messages;
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

function compactResponse(res) {
  if (!res) return null;
  return {
    code: res.code,
    msg: res.msg,
    error: res.error,
  };
}

function normalizeTalent(talent) {
  if (!talent) {
    return {
      name: null,
      phone: null,
      email: null,
      experience_years: null,
      degree: null,
      city: null,
      career_list: [],
      education_list: [],
      project_list: [],
      works_list: [],
      award_list: [],
      language_list: [],
      sns_list: [],
      resume_attachment_id_list: [],
      self_evaluation: null,
      raw: null,
    };
  }
  return {
    name: talent.basic_info?.name || '',
    phone: talent.basic_info?.mobile || talent.basic_info?.phone || null,
    email: talent.basic_info?.email || null,
    experience_years: talent.basic_info?.experience_years ?? null,
    degree: resolveDegree(talent),
    city: talent.basic_info?.preferred_city_list?.[0]?.zh_name || talent.basic_info?.hometown_city?.zh_name || null,
    career_list: talent.career_list || [],
    education_list: talent.education_list || [],
    project_list: talent.project_list || [],
    works_list: talent.works_list || [],
    award_list: talent.award_list || [],
    language_list: talent.language_list || [],
    sns_list: talent.sns_list || [],
    resume_attachment_id_list: talent.resume_attachment_id_list || [],
    self_evaluation: talent.self_evaluation || null,
    raw: talent,
  };
}

function normalizeJob(job, jobId) {
  if (!job) {
    return { name: jobId ? `(${jobId})` : null, city: null, department: null, salary: null, description: null };
  }
  return {
    name: (typeof job.title === 'string' ? job.title : job.title?.zh_cn || job.title?.en_us) || job.code || `(${jobId})`,
    city: job.city?.zh_name || job.city_list?.[0]?.name?.zh_cn || null,
    department: job.department?.zh_name || null,
    salary: job.min_salary && job.max_salary ? `${job.min_salary}-${job.max_salary}K` : null,
    description: job.description || job.requirement || null,
  };
}

function resolveDegree(talent) {
  const top = talent.top_degree;
  if (top && top !== 9 && top !== 0 && TOP_DEGREE_MAP[top]) return TOP_DEGREE_MAP[top];
  const first = talent.first_degree;
  if (first && first !== 0 && first !== 6 && first !== 7 && FIRST_DEGREE_MAP[first]) return FIRST_DEGREE_MAP[first];
  return null;
}

function buildCareerSummary(talent) {
  const careers = talent?.career_list || [];
  if (!careers.length) return null;
  return careers
    .sort((a, b) => (b.start_time || 0) - (a.start_time || 0))
    .map(career => {
      const company = career.company || '未知公司';
      const title = career.title || '';
      const type = career.type === 1 ? '全职' : career.type === 2 ? '实习' : '';
      const parts = [title, type].filter(Boolean).join('/');
      return parts ? `${company}(${parts})` : company;
    })
    .join('；');
}

function buildEducationSummary(talent) {
  const edus = talent?.education_list || [];
  if (!edus.length) return null;
  return edus
    .sort((a, b) => (b.degree || 0) - (a.degree || 0))
    .map(edu => {
      const school = edu.school || '未知学校';
      const degree = TOP_DEGREE_MAP[edu.degree] || '';
      const major = edu.field_of_study || '';
      const parts = [degree, major].filter(Boolean).join('/');
      return parts ? `${school}(${parts})` : school;
    })
    .join('；');
}

function buildProjectSummary(talent) {
  const projects = talent?.project_list || [];
  if (!projects.length) return null;
  return projects
    .map(project => {
      const name = project.name || '未知项目';
      const role = project.role || '';
      const desc = project.desc || '';
      const period = [project.start_time, project.end_time].filter(Boolean).join('-');
      return [name, role && `角色:${role}`, period && `时间:${period}`, desc].filter(Boolean).join('，');
    })
    .join('；');
}

function buildWorksSummary(talent) {
  const works = talent?.works_list || [];
  if (!works.length) return null;
  return works
    .map(work => {
      const name = work.name || '未命名作品';
      const desc = work.desc || '';
      const link = work.link || '';
      return [name, desc, link].filter(Boolean).join('，');
    })
    .join('；');
}

function mapSource(info) {
  const name = info?.name?.zh_cn || '';
  if (name.includes('BOSS') || name.includes('直聘')) return 'BOSS直聘';
  if (name.includes('猎聘')) return '猎聘';
  if (name.includes('拉勾')) return '拉勾';
  if (name.includes('内推')) return '内推';
  if (!name) return null;
  return '其他';
}

function mapHireCity(app, talent, job) {
  const city = app.application_preferred_city_list?.[0]?.name?.zh_cn || talent?.city || job?.city || null;
  return mapCity(city);
}

function mapCity(city) {
  return city ? String(city).trim() : null;
}

function mapPosition(position) {
  if (!position) return '其他';
  const p = position.toLowerCase();
  if (p.includes('sae') || p.includes('高级客户执行')) return 'SAE';
  if (p.includes('内容') && p.includes('ae')) return '内容AE';
  if (p.includes('reddit')) return 'AE';
  if (p.includes('ae') || p.includes('客户执行') || p.includes('account exec')) return 'AE';
  if (p.includes('媒介')) return '媒介';
  if (p.includes('项目经理') || p.includes('project manager') || p.includes('pm')) return '项目经理';
  if (p.includes('商务')) return '商务经理';
  if (p.includes('策划')) return '策划';
  if (p.includes('优化')) return '优化师';
  if (p.includes('海外') && p.includes('统筹')) return '海外项目统筹';
  return '其他';
}

function parseFilename(filename) {
  const cleaned = filename.replace(/\.eml$/i, '').replace(/【BOSS直聘】/, '').trim();
  const parts = cleaned.split(' | ').map(item => item.trim());
  const name = parts[0] || null;
  let experience = '';
  let position = '';
  let cityAndSalary = '';

  if (parts.length >= 3) {
    const middle = parts[1] || '';
    const expMatch = middle.match(/^(.+?)，应聘\s*(.+)$/);
    if (expMatch) {
      experience = expMatch[1];
      position = expMatch[2];
    } else {
      position = middle;
    }
    cityAndSalary = parts[2] || '';
  } else if (parts.length === 2) {
    cityAndSalary = parts[1] || '';
  }

  let workYears = null;
  if (experience.includes('应届')) {
    workYears = 0;
  } else {
    const yearMatch = experience.match(/(\d+)年/);
    if (yearMatch) workYears = Number.parseInt(yearMatch[1], 10);
  }

  let city = null;
  let salary = null;
  const cityMatch = cityAndSalary.match(/^(成都|深圳|杭州|北京|上海|广州|武汉)/);
  if (cityMatch) {
    city = cityMatch[1];
    salary = cityAndSalary.slice(city.length).trim();
  }

  return { name, position, city, salary, workYears };
}

function extractResumeFromEml(downloadUrl, name, errors) {
  if (!downloadUrl) {
    errors.push({ stage: 'email_attachment_download_url', name, message: 'missing download url' });
    return { text: '', parsed: {} };
  }

  const safeName = String(name || 'unknown').replace(/[^\w.-]+/g, '_').slice(0, 40);
  const token = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const emlPath = path.join(EMAIL_WORK_DIR, `${safeName}_${token}.eml`);
  const pdfPath = path.join(EMAIL_WORK_DIR, `${safeName}_${token}.pdf`);
  const txtPath = path.join(EMAIL_WORK_DIR, `${safeName}_${token}.txt`);

  try {
    execFileSync('curl', ['-s', '-L', '-o', emlPath, downloadUrl], { timeout: 30000 });
  } catch (error) {
    errors.push({ stage: 'email_attachment_download', name, message: error.message });
    return { text: '', parsed: {} };
  }

  try {
    execFileSync('python3', ['-c', `
import email
with open(${JSON.stringify(emlPath)}, 'rb') as f:
    msg = email.message_from_binary_file(f)
for part in msg.walk():
    payload = part.get_payload(decode=True)
    fn = part.get_filename() or ''
    ct = part.get_content_type()
    if payload and (fn.lower().endswith('.pdf') or ct == 'application/pdf' or ct == 'application/octet-stream'):
        with open(${JSON.stringify(pdfPath)}, 'wb') as out:
            out.write(payload)
        break
`], { timeout: 15000 });
  } catch (error) {
    errors.push({ stage: 'email_eml_parse', name, message: error.message });
    return { text: '', parsed: {} };
  }

  if (!existsSync(pdfPath)) {
    errors.push({ stage: 'email_pdf_extract', name, message: 'no pdf found in eml' });
    return { text: '', parsed: {} };
  }

  try {
    const text = extractPdfText(pdfPath, txtPath);
    return { text, parsed: parseResumeText(text) };
  } catch (error) {
    errors.push({ stage: 'email_pdf_text', name, message: error.message });
    return { text: '', parsed: {} };
  }
}

function extractPdfText(pdfPath, txtPath) {
  try {
    execFileSync('pdftotext', [pdfPath, txtPath], { timeout: 15000 });
    return readFileSync(txtPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const python = existsSync(BUNDLED_PYTHON) ? BUNDLED_PYTHON : 'python3';
  const script = `
from pypdf import PdfReader
reader = PdfReader(${JSON.stringify(pdfPath)})
parts = []
for page in reader.pages:
    parts.append(page.extract_text() or "")
print("\\n".join(parts))
`;
  return execFileSync(python, ['-c', script], {
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 10 * 1024 * 1024,
  });
}

function parseResumeText(text) {
  const allLines = text.split('\n').map(line => line.trim());
  const rawText = allLines.join('\n');
  const lines = allLines.filter(line => line.length > 2);
  const clean = lines.join('\n');

  const parsed = {};
  const nameMatch = rawText.match(/姓\s*名[：:]\s*([^\n\r]{2,4})/);
  if (nameMatch) parsed.realName = nameMatch[1].trim();

  const phoneMatch = rawText.match(/(?:手机|电话|联系)[号码方式]*[：:]\s*(\d{11})/) || rawText.match(/\b(1[3-9]\d{9})\b/);
  if (phoneMatch) parsed.phone = phoneMatch[1];

  const emailMatch = clean.match(/邮箱[：:]\s*(\S+@\S+)/) || clean.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
  if (emailMatch) parsed.email = emailMatch[1];

  if (/博士/.test(rawText)) parsed.degree = '博士';
  else if (/硕士|研究生/.test(rawText)) parsed.degree = '硕士';
  else if (/本科|学士/.test(rawText)) parsed.degree = '本科';
  else if (/大专|专科/.test(rawText)) parsed.degree = '大专';

  const expEntries = [];
  const expPattern = /(\d{4}[.\-年]\d{1,2})[月\s]*[–—\-~至]+\s*(\d{4}[.\-年]\d{1,2}|至今|今)[月\s]*\n\s*(.+?)\n\s*(.+)/g;
  let match;
  while ((match = expPattern.exec(clean)) !== null) {
    const company = match[3].trim();
    const title = match[4].trim();
    if (company && title && !company.includes('学校') && !company.includes('学院') && !company.includes('大学')) {
      expEntries.push(`${company}(${title})`);
    }
  }
  if (expEntries.length) parsed.experience = expEntries.join('；');

  const years = [];
  const yearPattern = /(\d{4})[.\-年]/g;
  let yearMatch;
  while ((yearMatch = yearPattern.exec(clean)) !== null) {
    const year = Number.parseInt(yearMatch[1], 10);
    if (year >= 2000 && year <= 2030) years.push(year);
  }
  if (years.length >= 2) {
    const workYears = Math.max(...years) - Math.min(...years);
    if (workYears > 0 && workYears < 40) parsed.workYears = workYears;
  }

  return parsed;
}

function unique(values) {
  return [...new Set(values)];
}

function buildUniqueKey(channel, identity, jobName) {
  return [channel, normalizeKeyPart(identity), normalizeKeyPart(jobName || 'unknown_job')].join(':');
}

function normalizeKeyPart(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/:/g, '：') || 'unknown';
}

function sleep(ms) {
  execSync(`sleep ${ms / 1000}`);
}

function normalizeEpochMs(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'string' && Number.isNaN(Number(value))) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return number < 1e12 ? number * 1000 : number;
}

function nowBeijing() {
  return new Date();
}

function toBeijingIso(date) {
  const beijingMs = date.getTime() + 8 * 60 * 60 * 1000;
  return `${new Date(beijingMs).toISOString().slice(0, 19)}+08:00`;
}

function formatBeijingForFile(date) {
  const beijingMs = date.getTime() + 8 * 60 * 60 * 1000;
  return new Date(beijingMs).toISOString().slice(0, 19).replace(/[-:T]/g, '').replace(/^(\d{4})(\d{2})(\d{2})(\d{6})$/, '$1-$2-$3_$4');
}
