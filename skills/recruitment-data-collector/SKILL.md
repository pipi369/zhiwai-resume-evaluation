---
name: recruitment-data-collector
description: Collect recruitment candidates from Feishu Hire or resume email into dated local JSON files only. 招聘数据采集：固定入参、固定输出、固定执行脚本，只读拉取飞书招聘或邮箱简历数据。
version: 0.1.0
owner: guan
updated: 2026-05-31
authority: local-write-only
---

# 招聘数据采集

## 使用范围

当用户要求拉取招聘候选人数据、同步飞书招聘投递、同步邮箱/BOSS 简历时，使用这个 Skill。

这个 Skill 只做一件事：**读取外部招聘数据，写成本地日期 JSON**。

禁止做：

- 不评估候选人。
- 不生成写回预览。
- 不写飞书、多维表格或邮箱。
- 不修改外部系统状态。
- 不自行新增入口参数。
- 不绕过指定脚本手写采集流程。

## 固定执行脚本

必须执行仓库内这个脚本：

```text
scripts/collect-recruitment-data.mjs
```

只能用下面两种命令之一：

```bash
node scripts/collect-recruitment-data.mjs --channel feishu_hire --workdir <workdir>
node scripts/collect-recruitment-data.mjs --channel email_resume --workdir <workdir>
```

日常运行不要添加其他参数。不要让用户指定 `since`、`until`、`dedupe_key`、邮箱规则、岗位过滤、输出文件名等细节。

## 入参

脚本只接受两个入参。

| 参数 | 必填 | 合法值 | 含义 |
|---|---:|---|---|
| `--channel` | 是 | `feishu_hire` / `email_resume` | 本次采集渠道 |
| `--workdir` | 是 | 本地目录路径 | 本次 pipeline 工作路径 |

渠道选择规则：

- 用户说“拉飞书招聘数据 / 飞书投递 / Hire 数据”，使用 `feishu_hire`。
- 用户说“拉邮箱简历 / BOSS 邮件简历”，使用 `email_resume`。
- 用户说“拉所有新简历”，依次执行两个命令；两个渠道分别产出 JSON。
- 渠道不明确时，必须先问用户，不能猜。

## 工作路径

所有采集相关文件都放在 `workdir` 下：

```text
<workdir>/
  collected/
  runtime-state.json
```

输出目录固定：

```text
<workdir>/collected/
```

水位文件固定：

```text
<workdir>/runtime-state.json
```

## 时间范围

脚本自行计算时间范围，不从入口参数读取时间。

规则：

- `end`：当前北京时间。
- `start`：读取 `<workdir>/runtime-state.json` 中当前渠道的 `last_success_at`。
- 如果当前渠道没有 `last_success_at`，`start` 默认为当前北京时间往前 1 小时。

`runtime-state.json` 结构：

```json
{
  "collection": {
    "feishu_hire": {
      "last_success_at": "2026-05-31T15:17:43+08:00",
      "last_output_file": "/abs/path/workspace/collected/2026-05-31_151743_feishu_hire.json",
      "updated_at": "2026-05-31T15:17:43+08:00"
    },
    "email_resume": {
      "last_success_at": "2026-05-31T15:23:33+08:00",
      "last_output_file": "/abs/path/workspace/collected/2026-05-31_152333_email_resume.json",
      "updated_at": "2026-05-31T15:23:33+08:00"
    }
  }
}
```

状态更新规则：

- 只有本地 JSON 成功写入后，才能推进水位。
- 只更新本次执行的 `channel`。
- `last_success_at` 更新为本次 `end`。
- 发生 fatal source error 时，不更新 `runtime-state.json`。
- 单个候选人解析失败但整体 JSON 写入成功时，可以推进水位，错误写入 `errors`。

## 出参

脚本没有 stdout JSON 作为正式出参。正式出参是本地 JSON 文件。

输出路径固定：

```text
<workdir>/collected/YYYY-MM-DD_HHmmss_<channel>.json
```

示例：

```text
workspace/collected/2026-05-31_151743_feishu_hire.json
workspace/collected/2026-05-31_152333_email_resume.json
```

执行完成后，必须向用户报告：

- `channel`
- 时间范围 `start -> end`
- 输出 JSON 路径
- `summary.total_fetched`
- `summary.total`
- `summary.duplicate`
- `summary.failed`
- 是否更新了 `<workdir>/runtime-state.json`

## 输出 JSON 顶层结构

每个输出 JSON 必须是：

```json
{
  "run_id": "2026-05-31_151743_feishu_hire",
  "channel": "feishu_hire",
  "collected_at": "2026-05-31T15:17:43+08:00",
  "time_range": {
    "start": "2026-05-31T14:17:43+08:00",
    "end": "2026-05-31T15:17:43+08:00"
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

## Candidate 结构

`candidates[]` 中每条记录必须是：

```json
{
  "unique_key": "string",
  "application_count": 1,
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
  "collected_at": "ISO-8601 +08:00"
}
```

字段含义：

- `unique_key`：业务唯一键，用于表示“同一候选人 + 同一岗位”。
- `application_count`：本轮同一 `unique_key` 出现次数。
- `display_fields`：给人看的摘要。
- `eval_input`：后续评估用的输入。
- `raw_refs`：审计追溯用的原始 ID、API 引用、邮件/附件 ID。

## 飞书招聘渠道逻辑

当 `channel=feishu_hire` 时，脚本按以下程序执行：

1. 读取 `<workdir>/runtime-state.json`，计算 `start/end`。
2. 调飞书投递列表接口分页读取 application ids：
   `GET /open-apis/hire/v1/applications`
   参数使用 `update_start_time/update_end_time` 缩小列表范围。
3. 对每个 application id 调投递详情：
   `GET /open-apis/hire/v1/applications/{application_id}`。
4. 只保留 `app.create_time` 落在 `start/end` 内的投递。
5. 收集唯一 `talent_id`，读取人才详情：
   `GET /open-apis/hire/v1/talents/{talent_id}`。
6. 收集唯一 `job_id`，读取职位详情：
   `GET /open-apis/hire/v1/jobs/{job_id}`。
7. 合并 application、talent、job，生成统一 candidate。
8. 写本地 JSON。
9. 如果没有 fatal error，更新本渠道水位。

飞书渠道 `display_fields` 至少尽量包含：

```json
{
  "name": "string | null",
  "phone": "string | null",
  "email": "string | null",
  "job_name": "string | null",
  "application_stage": "string | null",
  "applied_at": "ISO-8601 +08:00 | null",
  "source": "string | null",
  "city": "string | null",
  "degree": "string | null",
  "experience_years": "number | null",
  "career_summary": "string | null",
  "education_summary": "string | null",
  "project_summary": "string | null"
}
```

飞书渠道 `eval_input` 至少尽量包含：

```json
{
  "name": "string | null",
  "position": "string | null",
  "stage": "string | null",
  "degree": "string | null",
  "experience_years": "number | null",
  "career_summary": "string | null",
  "education_summary": "string | null",
  "project_summary": "string | null",
  "works_summary": "string | null",
  "career_list": [],
  "education_list": [],
  "project_list": [],
  "works_list": [],
  "award_list": [],
  "language_list": [],
  "sns_list": [],
  "self_evaluation": "string | null",
  "source_channel": "string | null",
  "city": "string | null",
  "hire_link": "string | null",
  "job_description": "string | null"
}
```

飞书渠道 `raw_refs` 必须尽量包含：

```json
{
  "application_id": "string | null",
  "talent_id": "string | null",
  "job_id": "string | null",
  "resume_attachment_id_list": []
}
```

## 邮箱简历渠道逻辑

当 `channel=email_resume` 时，脚本按以下程序执行：

1. 读取 `<workdir>/runtime-state.json`，计算 `start/end`。
2. 调飞书邮箱列表接口分页读取 INBOX 邮件：
   `GET /open-apis/mail/v1/user_mailboxes/{mailbox}/messages`
   参数固定 `folder_id=INBOX`、`page_size=20`。
3. 邮箱 API 不支持按时间参数过滤，所以脚本本地按邮件时间过滤。
4. 邮件时间大于 `end`：跳过。
5. 邮件时间小于 `start`：停止继续分页。
6. 只处理 subject 包含 `BOSS`、`boss` 或 `直聘` 的邮件。
7. 读取邮件详情。
8. 在邮件详情中找 `.eml` 附件，附件名必须包含 `BOSS`、`boss` 或 `直聘`。
9. 一封外层邮件只处理第一个符合条件的 `.eml` 附件。
10. 下载 `.eml` 附件。
11. 从 `.eml` 中提取 PDF。
12. 从 PDF 提取文本：优先 `pdftotext`，没有时使用 Python `pypdf` 回退。
13. 从附件文件名和 PDF 文本中提取姓名、岗位、城市、薪资、工作年限、电话、邮箱、学历、经历摘要。
14. 生成统一 candidate。
15. 写本地 JSON。
16. 如果没有 fatal error，更新本渠道水位。

邮箱渠道 `display_fields` 至少尽量包含：

```json
{
  "sender": "string | null",
  "subject": "string | null",
  "received_at": "ISO-8601 +08:00 | null",
  "attachment_names": [],
  "job_name": "string | null",
  "name": "string | null",
  "phone": "string | null",
  "email": "string | null",
  "city": "string | null",
  "salary": "string | null",
  "work_years": "number | null",
  "degree": "string | null"
}
```

邮箱渠道 `eval_input` 至少尽量包含：

```json
{
  "name": "string | null",
  "position": "string | null",
  "resume_text": "string",
  "email_subject": "string | null",
  "email_body": "string | null",
  "attachments": [],
  "degree": "string | null",
  "experience": "string | null",
  "work_years": "number | null",
  "job_description": null
}
```

邮箱渠道 `raw_refs` 必须尽量包含：

```json
{
  "mailbox_id": "string",
  "message_id": "string",
  "attachment_ids": [],
  "skipped_attachment_ids": []
}
```

## 去重规则

每个渠道使用固定规则生成 `dedupe_key`：

- `feishu_hire`：优先使用 `application_id`，没有时使用 `talent_id + job_id`。
- `email_resume`：使用 `message_id + attachment_id`。

每个渠道使用固定规则生成 `unique_key`：

- `feishu_hire`：`feishu_hire:<candidate_id 或 application_id>:<job_name>`。
- `email_resume`：`email_resume:<job_name>:<name>`；如果姓名缺失，用 `source_record_id` 兜底。

去重处理：

- 每次运行都生成新的日期 JSON，不覆盖历史 JSON。
- 本轮内部重复的 `dedupe_key` 不进入 `candidates`，写入 `duplicates`。
- 本轮内部相同 `unique_key` 会合并成一条 candidate，并累加 `application_count`。
- 被合并记录的来源 ID 必须保留在 `raw_refs.source_record_ids` 中。
- 历史 collected JSON 只作为审计快照，不参与本次去重。
- 历史中存在同一个 `dedupe_key` 时，本轮仍允许进入 `candidates`。
- 不要跨渠道静默合并候选人。

## 错误规则

`errors[]` 用于记录 API、下载、解析、字段缺失等问题。

Fatal error：

- 入口列表接口失败，例如投递列表失败、邮箱列表失败。
- 发生 fatal error 时，仍可以写错误 JSON，但不能更新水位。

非 fatal error：

- 单个投递详情失败。
- 单个人才/职位详情失败。
- 单个邮箱附件下载或解析失败。

非 fatal error 不阻止整体 JSON 输出。

## 安全规则

- 执行前必须先经过 `execution-gate`。
- 只允许读外部系统。
- 只允许写 `<workdir>` 下的本地 JSON 和 runtime-state。
- 不要把 `/tmp` 作为唯一产物存储位置；`/tmp` 只能放临时下载/解析文件。
- 不要把凭证、access token、secret 写入 JSON。
- 不要丢弃后续审计需要的原始引用。
