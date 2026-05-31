---
name: recruitment-data-collector
description: Collect recruitment candidates from Feishu Hire or resume email into dated local JSON files only. 招聘数据采集：按渠道拉取飞书招聘或邮箱简历数据，并只写入本地日期 JSON。
version: 0.1.0
owner: guan
updated: 2026-05-31
authority: local-write-only
---

# 招聘数据采集

## 目的

从指定招聘渠道拉取候选人数据，整理成统一候选人 JSON，写入本地文件。

这个 Skill 只负责采集数据，不评估候选人，不生成写回预览，不写飞书。

## 渠道

当前支持两个采集渠道：

- `feishu_hire`：飞书招聘渠道。
- `email_resume`：邮箱简历渠道。

每次执行必须明确本次采集渠道。不能在渠道不明确时自行猜测。

如果用户说“拉飞书招聘数据”，使用 `feishu_hire`。  
如果用户说“拉邮箱简历/BOSS 邮件简历”，使用 `email_resume`。  
如果用户说“拉所有新简历”，可以依次执行两个渠道，但两个渠道必须分别产出本地 JSON。

## 入口参数

采集脚本只接受两个入口参数：

- `channel`：本次采集渠道，只能是 `feishu_hire` 或 `email_resume`。
- `workdir`：本次 pipeline 工作路径。

不要暴露额外参数给日常运行使用。不要让用户指定 `since`、`until`、`dedupe_key`、邮箱规则、岗位过滤、输出文件名等细节。

示例：

```bash
node scripts/collect-recruitment-data.mjs --channel feishu_hire --workdir workspace
node scripts/collect-recruitment-data.mjs --channel email_resume --workdir workspace
```

## 工作路径约定

所有采集相关文件都放在 `workdir` 下：

```text
<workdir>/
  collected/
  runtime-state.json
```

输出目录固定为：

```text
<workdir>/collected/
```

水位文件固定为：

```text
<workdir>/runtime-state.json
```

## 时间范围规则

拉取数据时，直接从 `<workdir>/runtime-state.json` 读取对应渠道的上一次成功拉取时间。

- `start`：对应渠道的 `last_success_at`。
- `end`：当前北京时间。
- 如果没有找到该渠道的 `last_success_at`，`start` 默认为当前北京时间往前 1 小时。

渠道由用户请求或上层 orchestrator 指定。这个 Skill 不通过复杂配置决定渠道。

## 固定输出格式

每次采集写一个本地日期 JSON 文件：

```text
<workdir>/collected/YYYY-MM-DD_HHmmss_<channel>.json
```

示例：

```text
workspace/collected/2026-05-31_143000_feishu_hire.json
workspace/collected/2026-05-31_143000_email_resume.json
```

输出 JSON 顶层结构：

```json
{
  "run_id": "2026-05-31_143000_feishu_hire",
  "channel": "feishu_hire",
  "collected_at": "2026-05-31T14:30:00+08:00",
  "time_range": {
    "start": "ISO-8601 | null",
    "end": "ISO-8601 | null"
  },
  "candidates": [],
  "duplicates": [],
  "errors": [],
  "summary": {
    "total_fetched": 0,
    "total": 0,
    "duplicate": 0,
    "failed": 0
  }
}
```

## 状态更新

采集完成并成功写入本地 JSON 后，必须更新 `<workdir>/runtime-state.json` 中对应渠道的 `last_success_at`。

更新规则：

- 只更新本次执行的 `channel`。
- 将该渠道的 `last_success_at` 更新为本次采集的 `end` 时间，时间必须使用北京时间 ISO-8601 格式。
- 只有当输出 JSON 成功写入后，才能推进水位。
- 如果采集失败、JSON 写入失败、或结果不可用，不能推进 `last_success_at`。
- 如果部分候选人失败，但整体 JSON 已成功写入，应推进水位，并把失败候选人记录在输出 JSON 的 `errors` 中。

示例：

```json
{
  "collection": {
    "feishu_hire": {
      "last_success_at": "2026-05-31T14:30:00+08:00"
    },
    "email_resume": {
      "last_success_at": "2026-05-31T10:00:00+08:00"
    }
  }
}
```

## 候选人统一结构

两个渠道最终都要整理成统一候选人结构：

```json
{
  "candidate_id": "string",
  "channel": "feishu_hire | email_resume",
  "source_record_id": "string",
  "dedupe_key": "string",
  "job_id": "string | null",
  "job_name": "string | null",
  "application_id": "string | null",
  "display_fields": {},
  "eval_input": {},
  "raw_refs": {},
  "collected_at": "ISO-8601"
}
```

`display_fields` 放给人看的摘要字段。  
`eval_input` 放后续评估需要的候选人信息。  
`raw_refs` 放可追溯的原始 ID、API 路径、邮件 ID、附件 ID 等引用。

## 飞书招聘渠道：`feishu_hire`

### 目标

从飞书招聘读取投递、人才、职位相关数据，整理为候选人 JSON。

### 只读数据源

允许读取：

- 投递列表。
- 投递详情。
- 人才详情。
- 职位详情。

不得执行：

- 修改飞书招聘状态。
- 写入飞书多维表格。
- 修改候选人、职位、投递记录。

### 飞书候选人字段要求

`display_fields` 建议包含：

```json
{
  "name": "string",
  "phone": "string | null",
  "email": "string | null",
  "job_name": "string | null",
  "application_stage": "string | null",
  "applied_at": "ISO-8601 | null",
  "source": "string | null"
}
```

`eval_input` 建议包含：

```json
{
  "resume_text": "string",
  "work_experience": [],
  "education": [],
  "projects": [],
  "skills": [],
  "job_description": "string | null"
}
```

`raw_refs` 必须尽量保留：

```json
{
  "application_id": "string",
  "talent_id": "string | null",
  "job_id": "string | null"
}
```

## 邮箱简历渠道：`email_resume`

### 目标

从邮箱读取简历邮件和附件信息，整理为候选人 JSON。

### 只读数据源

允许读取：

- 邮件列表。
- 邮件详情。
- 附件下载链接。
- 简历附件文本，若已有可用解析能力。

不得执行：

- 发送邮件。
- 修改邮件状态。
- 删除邮件。
- 写入飞书。

### 邮箱候选人字段要求

`display_fields` 建议包含：

```json
{
  "sender": "string | null",
  "subject": "string | null",
  "received_at": "ISO-8601 | null",
  "attachment_names": [],
  "job_name": "string | null"
}
```

`eval_input` 建议包含：

```json
{
  "resume_text": "string",
  "email_subject": "string | null",
  "email_body": "string | null",
  "attachments": [],
  "job_description": "string | null"
}
```

`raw_refs` 必须尽量保留：

```json
{
  "mailbox_id": "string",
  "message_id": "string",
  "attachment_ids": []
}
```

## 固定去重规则

每个渠道使用固定规则生成 `dedupe_key`，不要求用户额外配置。

规则：

- `feishu_hire`：优先使用 `application_id`，没有时使用 `talent_id + job_id`。
- `email_resume`：优先使用 `message_id + attachment_id`，没有附件时使用 `message_id`。

去重处理：

- 每次运行都生成新的日期 JSON，不覆盖历史 JSON。
- 本轮内部重复的 `dedupe_key` 不进入 `candidates`，写入 `duplicates`。
- 历史 collected JSON 只作为审计快照，不参与本次去重。
- 即使某个 `dedupe_key` 已经存在于历史 collected JSON，只要它出现在本轮拉取结果里，也允许进入本轮 `candidates`。
- 不要跨渠道静默合并候选人。跨渠道合并应由后续独立步骤处理。

## 安全规则

- 采集前必须先经过 `execution-gate`。
- 只允许读外部系统，不能写外部系统。
- 成功写入本地 JSON 后，允许更新 `<workdir>/runtime-state.json` 中本渠道的水位。
- 不要把 `/tmp` 作为唯一存储位置。
- 不要把凭证、access token、secret 写入 JSON。
- 不要丢弃后续审计需要的原始引用。
- API 返回字段不完整时，保留当前候选人，并在 `errors` 中记录缺失项。

## 完成报告

完成后报告：

- 本次 `channel`。
- 输出 JSON 路径。
- 采集候选人数量。
- 新增、重复、失败数量。
- 本次使用的时间范围或 cursor。
- 缺失字段或异常说明。
