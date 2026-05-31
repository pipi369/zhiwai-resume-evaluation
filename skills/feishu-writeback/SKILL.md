---
name: feishu-writeback
description: Generate Feishu Bitable write previews and require explicit confirmation before live writeback. 飞书写回：先生成本地写入预览，用户明确确认后才允许写回多维表格。
version: 0.1.0
owner: guan
updated: 2026-05-31
authority: confirmation-required-for-live-write
---

# 飞书写回

## 目的

把本地评估结果转换成写入预览，校验字段映射，并且只在用户明确确认后写回飞书。

## 模式

Preview 模式：

- 默认允许。
- 读取本地评估结果。
- 生成 `write_preview`。
- 不调用飞书写 API。

Live 模式：

- 必须针对具体 run 或 preview 获得用户明确确认。
- 可以新增或更新飞书多维表格记录。
- 必须生成本地写回结果报告。

定时任务必须停留在 Preview 模式。

## 输入

读取：

- `.local/pipeline.config.json`
- `.local/runtime-state.json`
- `workspace/recruitment-pipeline.xlsx`
- `workspace/runs/<run_id>/eval-results.json`
- `config/field-mapping.example.json`，只在真实 mapping 缺失时作为参考

必需配置：

- 飞书 `app_token`
- 飞书 `table_id`
- 可选 `view_id`
- 从评估结果到多维表字段的映射
- 去重/更新键
- create/update 策略

## 预览输出

写入：

- `workspace/recruitment-pipeline.xlsx` 的 `write_preview` sheet。
- `workspace/runs/<run_id>/write-preview.json`
- `workspace/runs/<run_id>/run-report.md`

预览项契约：

```json
{
  "run_id": "string",
  "candidate_id": "string",
  "operation": "create | update | skip",
  "target": {
    "app_token": "string",
    "table_id": "string",
    "record_id": "string | null"
  },
  "dedupe_key": "string",
  "fields": {},
  "validation": {
    "status": "ok | warning | error",
    "messages": []
  }
}
```

## Live 写回规则

Live 写回前必须展示：

- `run_id`
- 目标 app/table。
- 预计 create、update、skip 和 validation error 数量。
- 将要写入的准确字段。
- 是否存在 warning。

只有用户确认本次具体写回后，才能继续。

Live 写回后写入：

- `workspace/runs/<run_id>/write-result.json`
- `workspace/runs/<run_id>/run-report.md`
- 更新后的 `run_state`

## 安全规则

- 生成预览前必须经过 `execution-gate`，live 写回前必须再次经过 `execution-gate`。
- 定时任务永远不能 live 写回。
- 字段映射存在 validation error 时不能写回。
- 不要猜测目标表或去重键。
- 不要写入配置 allowlist 之外的字段。
- 必须保留足够的本地产物，用来审计每一条 create/update/skip 决策。

