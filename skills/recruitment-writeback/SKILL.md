---
name: recruitment-writeback
description: Generate write previews from evaluated recruitment JSON and write results back to Feishu Bitable only after explicit confirmation. 招聘写回：读取本地评估结果，先生成写回预览，确认后才写回飞书多维表格。
version: 0.1.0
owner: guan
updated: 2026-05-31
authority: confirmation-required-for-live-write
---

# 招聘写回

## 使用范围

当用户要求把评估结果写回飞书、多维表格、候选人表，或生成写回预览时，使用这个 Skill。

这个 Skill 只做两件事：

1. 从 evaluated JSON 生成本地写回预览。
2. 在用户明确确认后，把预览写回飞书多维表格。

## 禁止事项

- 不采集数据。
- 不评估候选人。
- 不直接跳过 preview 执行写回。
- 不在用户未确认时写飞书。
- 不修改 evaluated JSON。
- 不猜测目标表、匹配字段或写回字段。

## 固定执行脚本

必须执行仓库内这个脚本：

```text
scripts/writeback-evaluation-results.mjs
```

生成预览：

```bash
node scripts/writeback-evaluation-results.mjs --mode preview --input <evaluated_json> --workdir <workdir>
```

确认后写回：

```bash
node scripts/writeback-evaluation-results.mjs --mode apply --input <write_preview_json> --workdir <workdir>
```

日常运行不要添加其他参数。

## 入参

| 参数 | 必填 | 合法值 | 含义 |
|---|---:|---|---|
| `--mode` | 是 | `preview` / `apply` | 运行模式 |
| `--input` | 是 | 本地 JSON 路径 | preview 模式读取 evaluated JSON；apply 模式读取 write-preview JSON |
| `--workdir` | 是 | 本地目录路径 | pipeline 工作路径 |

## 工作路径

写回相关文件都放在 `workdir` 下：

```text
<workdir>/
  evaluated/
  write-preview/
  write-result/
  writeback-config.json
```

写回配置：

```text
<workdir>/writeback-config.json
```

预览输出目录：

```text
<workdir>/write-preview/
```

写回结果目录：

```text
<workdir>/write-result/
```

## 写回配置

脚本必须读取：

```text
<workdir>/writeback-config.json
```

配置结构：

```json
{
  "target_table": {
    "app_token": "string",
    "table_id": "string"
  },
  "field_mapping": {
    "name": "姓名",
    "job_name": "应聘岗位",
    "channel": "来源渠道",
    "received_at": "简历接收日期",
    "city": "工作城市",
    "feedback": "简历反馈",
    "match_points": "简历匹配点",
    "risk_points": "简历风险点"
  },
  "notification": {
    "enabled": false,
    "webhook_url": "string",
    "keyword": "招聘评估"
  }
}
```

说明：

- `target_table.app_token`：飞书多维表格 app token。
- `target_table.table_id`：目标表 table id。
- `field_mapping`：从 evaluated JSON 的英文字段映射到飞书目标字段。
- `notification.enabled`：是否在 apply 成功生成本地写回结果后发送飞书群机器人通知。
- `notification.webhook_url`：飞书自定义机器人 webhook 地址。本地配置，不要提交到 Git。
- `notification.keyword`：如果机器人开启了关键词校验，通知文本会包含这个关键词。

不要把飞书 app secret、tenant token 或 access token 写入配置文件。

## Preview 模式

Preview 模式只生成本地预览，不写飞书。

输入：

```text
<workdir>/evaluated/<input_basename>.evaluated.json
```

输出：

```text
<workdir>/write-preview/<input_basename>.write-preview.json
```

执行流程：

1. 读取 evaluated JSON。
2. 读取 writeback-config JSON。
3. 读取飞书目标表字段列表，校验目标字段存在。
4. 对每条评估结果生成写回动作：
   - 字段校验通过：`operation=create`
   - 字段校验失败：`operation=skip`
5. 生成本地 write-preview JSON。
6. 报告预计 create/skip/error 数量。

Preview 模式不发送群通知。

第一版只新增记录，不匹配已有记录，不更新已有记录。

## Preview JSON 结构

```json
{
  "preview_id": "2026-05-31_151743_feishu_hire",
  "source_file": "workspace/evaluated/2026-05-31_151743_feishu_hire.evaluated.json",
  "created_at": "2026-05-31T17:00:00+08:00",
  "target_table": {
    "app_token": "string",
    "table_id": "string"
  },
  "match": {
    "mode": "create_only"
  },
  "items": [],
  "errors": [],
  "summary": {
    "total": 0,
    "create": 0,
    "skip": 0,
    "error": 0
  }
}
```

`items[]` 结构：

```json
{
  "candidate_id": "string",
  "unique_key": "string | null",
  "application_count": 1,
  "source_record_id": "string",
  "display_fields": {
    "name": "string | null",
    "job_name": "string | null",
    "channel": "飞书招聘 | 邮箱 | string",
    "received_at": "ISO-8601 +08:00 | null",
    "city": "string | null"
  },
  "match_value": "string",
    "operation": "create | skip",
  "record_id": "string | null",
  "fields": {
    "姓名": "张三",
    "应聘岗位": "小红书优化师",
    "来源渠道": "飞书招聘",
    "简历接收日期": "2026-05-31T15:00:00+08:00",
    "工作城市": "成都",
    "简历反馈": "推荐面试",
    "简历匹配点": "string",
    "简历风险点": "string"
  },
  "validation": {
    "status": "ok | error",
    "messages": []
  }
}
```

## Apply 模式

Apply 模式会写飞书，必须用户明确确认。

执行 Apply 前，必须向用户展示并确认：

- preview 文件路径。
- 目标 app/table。
- 预计 create 数量。
- skip 数量。
- error 数量。
- 将要写入的字段。

只有用户明确说“确认写回这个 preview”后，才能执行：

```bash
node scripts/writeback-evaluation-results.mjs --mode apply --input <write_preview_json> --workdir <workdir>
```

禁止在定时任务中执行 apply。

## Apply 输出

写回结果必须写入：

```text
<workdir>/write-result/<preview_id>.write-result.json
```

结构：

```json
{
  "preview_id": "string",
  "preview_file": "string",
  "applied_at": "ISO-8601 +08:00",
  "results": [],
  "errors": [],
  "summary": {
    "total": 0,
    "created": 0,
    "skipped": 0,
    "failed": 0
  }
}
```

## 安全规则

- Preview 可以直接执行。
- Apply 必须用户明确确认。
- 定时任务只能执行 preview，不能执行 apply。
- 只允许写配置指定的字段。
- 字段校验失败时不能 apply。
- preview 中存在 `validation.status=error` 的 item 时不能 apply。
- 不要写入配置 allowlist 之外的字段。
- 不要把飞书 token、模型 key、secret 写入 preview 或 result。

## 完成报告

Preview 完成后报告：

- preview JSON 路径。
- create/skip/error 数量。
- 目标表。
- 写入字段。

Apply 完成后报告：

- write-result JSON 路径。
- created/skipped/failed 数量。
- 失败记录原因。

如果 `notification.enabled=true`，Apply 写入 write-result JSON 后发送“写回已执行”通知。

通知内容必须包含：

- 渠道。
- 评估结果总数。
- 推荐数量。
- 待 HR 确认数量。
- 不推荐数量。
- 信息不足/其他数量。

通知内容不要包含本地文件路径、preview_id 或写回明细。
