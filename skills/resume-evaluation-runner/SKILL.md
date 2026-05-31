---
name: resume-evaluation-runner
description: Evaluate candidate rows from the local recruitment workbook and write local results only. 简历评估调度：读取本地候选人、匹配岗位规则、调用评估 Skill，并只写本地结果。
version: 0.1.0
owner: guan
updated: 2026-05-31
authority: local-write-only
---

# 简历评估调度

## 目的

从本地 pipeline workbook 读取候选人，按岗位匹配评估标准，调用 `resume-evaluator` 完成单份简历评估，并把结构化结果写回本地产物。

这个 Skill 不负责采集数据，也绝不写飞书。

## 输入

读取：

- `.local/pipeline.config.json`
- `workspace/recruitment-pipeline.xlsx`
- `workspace/runs/<run_id>/collected-data.json`，当只评估某一轮 run 时

使用的 workbook sheet：

- `candidates`
- `position_skill_map`
- `criteria_library`
- `eval_results`
- `run_state`

## 评估流程

对每个候选人：

1. 从 `candidates` 读取候选人数据。
2. 根据 `job_id`、`job_name` 或配置的匹配列确定岗位。
3. 从 `position_skill_map` 查找对应评估标准。
4. 从 `criteria_library` 或引用的 criteria 文件加载标准。
5. 调用 `resume-evaluator` 评估单个候选人。
6. 将结果写入 `eval_results`。

如果候选人信息或评估标准不足，写入 `信息不足`，并记录明确原因。

## 输出契约

每条评估结果必须包含：

```json
{
  "run_id": "string",
  "candidate_id": "string",
  "source": "hire | mail | manual",
  "job_id": "string",
  "job_name": "string",
  "feedback": "推荐面试 | 待HR确认 | 不推荐 | 信息不足",
  "match_points": "string",
  "risk_points": "string",
  "criteria_name": "string",
  "evaluated_at": "ISO-8601",
  "error": "string | null"
}
```

## 本地输出

只能写：

- `workspace/recruitment-pipeline.xlsx` 的 `eval_results` sheet。
- `workspace/runs/<run_id>/eval-results.json`
- `workspace/runs/<run_id>/run-report.md`
- `workspace/runs/<run_id>/errors.json`，如有错误

不能写：

- `write_preview`
- 飞书记录
- 真实配置文件，除非用户明确确认

## 安全规则

- 评估前必须先经过 `execution-gate`。
- 不要编造简历里没有的信息。
- 如果多个岗位映射同时命中，不要静默选择，必须停止或记录为歧义。
- 不要写外部系统。
- 失败的候选人必须保留错误详情，不能直接丢弃。

## 完成报告

完成后报告：

- `run_id`
- 已评估候选人数。
- 各 `feedback` 值的数量。
- `信息不足` 的候选人。
- 缺失或歧义的岗位映射。
- 输出产物路径。

