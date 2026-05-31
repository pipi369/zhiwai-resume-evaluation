---
name: recruitment-pipeline-orchestrator
description: Run the full recruitment automation pipeline for scheduled jobs: collect Feishu/email resumes, evaluate candidates, preview writeback, apply writeback, and send notification. 招聘流水线编排：给龙虾定时调用，按固定顺序执行采集、评估、写回和通知。
version: 0.1.0
owner: guan
updated: 2026-05-31
authority: scheduled-orchestration
---

# 招聘流水线编排

## 使用范围

当用户要求龙虾定时执行招聘流程、跑完整链路、执行招聘 pipeline、批量采集评估写回时，使用这个 Skill。

这个 Skill 只负责编排已有脚本，不重写业务逻辑：

1. 采集飞书招聘渠道数据。
2. 采集邮箱渠道数据。
3. 对本轮采集到的新 JSON 做评估。
4. 对评估结果生成写回 preview。
5. 执行 apply 写回。
6. apply 后由写回脚本发送招聘评估通知。

## 固定执行脚本

必须执行仓库内这个脚本：

```text
scripts/run-recruitment-pipeline.mjs
```

定时任务命令：

```bash
node scripts/run-recruitment-pipeline.mjs --workdir workspace --writeback apply
```

不要让龙虾手动拼接 collector/evaluator/writeback 多个命令。

## 入参

| 参数 | 必填 | 合法值 | 含义 |
|---|---:|---|---|
| `--workdir` | 是 | 本地目录路径 | pipeline 工作路径 |
| `--writeback` | 是 | `apply` | 定时任务写回模式 |

日常定时运行固定传 `--workdir workspace --writeback apply`。

## 执行顺序

脚本固定处理两个渠道：

```text
feishu_hire
email_resume
```

每个渠道按顺序执行：

1. `collect`
   - 执行 `scripts/collect-recruitment-data.mjs`
   - 只读取本渠道水位。
   - 产出本轮 collected JSON。
2. 如果本轮候选人数为 0：
   - 跳过 evaluation 和 writeback。
   - 记录 `status=skipped_empty`。
3. `evaluate`
   - 执行 `scripts/evaluate-recruitment-data.mjs`
   - 只评估本轮 collected JSON。
4. `writeback preview`
   - 执行 `scripts/writeback-evaluation-results.mjs --mode preview`
   - 生成本轮 write-preview JSON。
5. `writeback apply`
   - apply 会写飞书多维表格。
   - apply 后如配置了机器人，会发送招聘评估通知。

## 工作路径

所有运行状态和产物都在 `workdir` 下：

```text
<workdir>/
  runtime-state.json
  evaluator-config.json
  writeback-config.json
  collected/
  evaluated/
  write-preview/
  write-result/
  pipeline-runs/
```

pipeline 结果写入：

```text
<workdir>/pipeline-runs/<run_id>.pipeline-result.json
```

## Pipeline Result

结构：

```json
{
  "run_id": "20260531_210000",
  "started_at": "2026-05-31T21:00:00+08:00",
  "finished_at": "2026-05-31T21:02:00+08:00",
  "writeback_mode": "apply",
  "channels": [
    {
      "channel": "feishu_hire",
      "status": "completed | skipped_empty | failed",
      "collected_file": "string | null",
      "evaluated_file": "string | null",
      "preview_file": "string | null",
      "result_file": "string | null",
      "candidates": 0,
      "error": "string | null"
    }
  ],
  "summary": {
    "collected_files": 0,
    "evaluated_files": 0,
    "preview_files": 0,
    "applied_files": 0,
    "skipped_empty": 0,
    "failed": 0
  }
}
```

## 执行规则

- 不要在编排 Skill 中直接调用大模型 API、飞书 API 或邮箱 API；这些由底层脚本负责。
- 不要改动 `runtime-state.json`、`evaluation-state.json`、lock 文件或 preview/result 文件，除非底层脚本自己写入。
- 某个渠道失败时，另一个渠道仍可继续执行；最终 `failed > 0` 时脚本退出码为 1。
- 候选人数为 0 时不进入 evaluate/writeback，避免生成无意义预览。

## 给龙虾的定时任务说明

让龙虾定时执行时，说清楚：

```text
在 zhiwai-resume-evaluation 仓库根目录执行：

node scripts/run-recruitment-pipeline.mjs --workdir workspace --writeback apply

不要拆开执行子脚本。
不要手动修改 workspace 文件。
执行结束后，把 pipeline result 路径和 summary 发给我。
如果 apply 成功，飞书机器人会自动发招聘评估统计通知。
```
