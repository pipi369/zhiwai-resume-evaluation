---
name: recruitment-evaluator
description: Evaluate collected recruitment candidate JSON by reading criteria from Feishu Bitable and calling a model API, then write local evaluated JSON only. 招聘评估：读取采集 JSON，从飞书多维表格读取评估标准，调用大模型 API，输出本地评估结果。
version: 0.1.0
owner: guan
updated: 2026-05-31
authority: local-write-only
---

# 招聘评估

## 使用范围

当用户要求评估已经采集好的候选人 JSON、批量评估简历、生成本地评估结果时，使用这个 Skill。

这个 Skill 只做一件事：**读取本地 collected JSON，调用评估脚本完成批量评估，写成本地 evaluated JSON**。

禁止做：

- 不采集新数据。
- 不写飞书候选人表或多维表格结果表。
- 不生成写回预览。
- 不让 OpenClaw/龙虾逐条手工评估。
- 不从本地 Skill 或本地文件读取岗位评估标准正文。
- 不绕过指定脚本自行拼 prompt 或调用模型。

## 固定执行脚本

必须执行仓库内这个脚本：

```text
scripts/evaluate-recruitment-data.mjs
```

命令格式：

```bash
node scripts/evaluate-recruitment-data.mjs --input <collected_json> --workdir <workdir>
```

日常运行不要添加其他参数。不要让用户指定单条 candidate、prompt 文件、criteria 文件、输出文件名或模型细节。

## 入参

脚本只接受两个入参。

| 参数 | 必填 | 含义 |
|---|---:|---|
| `--input` | 是 | `recruitment-data-collector` 生成的 collected JSON 文件 |
| `--workdir` | 是 | pipeline 工作路径 |

`--input` 必须是：

```text
<workdir>/collected/YYYY-MM-DD_HHmmss_<channel>.json
```

`channel` 可以是：

- `feishu_hire`
- `email_resume`

## 工作路径

评估相关文件都放在 `workdir` 下：

```text
<workdir>/
  collected/
  evaluated/
```

输入目录：

```text
<workdir>/collected/
```

输出目录：

```text
<workdir>/evaluated/
```

评估状态文件按 input 文件独立生成：

```text
<workdir>/evaluated/<input_basename>.evaluation-state.json
```

评估锁文件按 input 文件独立生成：

```text
<workdir>/evaluated/<input_basename>.evaluation.lock
```

## 评估标准来源

岗位评估标准必须从飞书多维表格读取。

本地仓库、Skill、脚本中只允许保存：

- 评估流程。
- prompt 固定框架。
- 输出 JSON schema。
- 字段映射逻辑。

不允许在本地维护岗位评估标准正文。

脚本应根据候选人的岗位信息匹配评估标准：

- 优先使用 `candidate.job_id`。
- 其次使用 `candidate.job_name`。
- 最后使用 `candidate.eval_input.position`。

如果找不到匹配的评估标准，该候选人必须输出：

```json
{
  "score": 0,
  "match_points": "",
  "risk_points": "无法评估：未找到岗位评估标准"
}
```

## 模型调用

模型调用必须由脚本完成，不由 OpenClaw/龙虾逐条执行。

模型请求使用 OpenAI-compatible chat completions 协议。请求体必须显式关闭思考：

```json
{
  "extra_body": {
    "enable_thinking": false
  }
}
```

如果 `workspace/evaluator-config.json` 中配置了 `model.enable_thinking` 或 `model.extra_options`，脚本可以读取并合并，但默认必须是 `enable_thinking=false`。

脚本负责：

1. 读取 collected JSON。
2. 从飞书多维表格读取岗位评估标准。
3. 根据 `candidate.channel` 选择字段，组装统一的人类可读候选人信息。
4. 根据候选人信息和岗位评估标准组装 prompt。
5. 调用大模型 API。
6. 校验模型输出。
7. 写入本地 evaluated JSON。
8. 更新本地 evaluation-state。

OpenClaw/龙虾只负责启动脚本和报告结果。

## Prompt 固定框架

脚本组装 prompt 时，必须使用固定开头和固定结尾。

固定开头：

```text
你是招聘简历评估助手。请只基于输入的候选人信息和岗位评估标准做判断，不要编造简历中没有的信息，不要推断敏感个人属性。

你的任务是判断该候选人是否适合进入面试，并给出适合 HR 阅读的简洁理由。
```

中间部分由脚本填充：

```text
【候选人信息】
<脚本根据 channel 组装的人类可读候选人信息>

【岗位评估标准】
<从飞书多维表格读取的 criteria>
```

候选人信息组装规则：

- `feishu_hire`：重点使用姓名、岗位、阶段、城市、学历、工作年限、工作经历、教育经历、项目经历、作品、获奖、语言能力、职位描述等字段。
- `email_resume`：重点使用姓名、岗位、城市、学历、工作年限、期望薪资、电话、邮箱、邮件主题、邮件正文、附件信息、简历正文等字段。
- 未知 channel：退回到通用字段和 `eval_input`。

固定结尾：

```text
请只输出 JSON，不要输出 Markdown，不要输出解释性前后缀。

JSON 格式必须是：
{
  "score": 1-10 的整数，无法判断时为 0,
  "match_points": "string",
  "risk_points": "string"
}

评分规则：
- 8-10分：强匹配，推荐面试
- 6-7分：基本匹配，推荐面试
- 4-5分：部分匹配，待 HR 确认
- 1-3分：不匹配，不推荐
- 0分：信息不足，无法判断
```

## 输出 JSON 路径

评估结果必须写入：

```text
<workdir>/evaluated/<input_basename>.evaluated.json
```

示例：

```text
workspace/evaluated/2026-05-31_151743_feishu_hire.evaluated.json
workspace/evaluated/2026-05-31_152333_email_resume.evaluated.json
```

## 输出 JSON 顶层结构

每个 evaluated JSON 必须是：

```json
{
  "run_id": "2026-05-31_151743_feishu_hire",
  "source_file": "workspace/collected/2026-05-31_151743_feishu_hire.json",
  "channel": "feishu_hire",
  "evaluated_at": "2026-05-31T16:00:00+08:00",
  "results": [],
  "errors": [],
  "summary": {
    "total": 0,
    "completed": 0,
    "failed": 0,
    "information_insufficient": 0
  }
}
```

## 单条评估结果结构

`results[]` 中每条记录必须是：

```json
{
  "candidate_id": "string",
  "unique_key": "string | null",
  "application_count": 1,
  "source_record_id": "string",
  "dedupe_key": "string",
  "channel": "feishu_hire | email_resume",
  "job_id": "string | null",
  "job_name": "string | null",
  "display_fields": {
    "name": "string | null",
    "job_name": "string | null",
    "channel": "飞书招聘 | 邮箱 | string",
    "received_at": "ISO-8601 +08:00 | null",
    "city": "string | null"
  },
  "criteria": {
    "criteria_id": "string | null",
    "criteria_name": "string | null",
    "matched_by": "job_id | job_name | position | none"
  },
  "evaluation": {
    "score": "0-10 integer",
    "feedback": "推荐面试 | 待HR确认 | 不推荐 | 信息不足",
    "match_points": "string",
    "risk_points": "string"
  },
  "model": {
    "provider": "string",
    "model": "string",
    "attempts": 1
  },
  "status": "completed | failed",
  "error": "string | null",
  "evaluated_at": "ISO-8601 +08:00"
}
```

## evaluation-state 与并发规则

评估脚本必须维护按 input 文件独立的状态文件：

```text
<workdir>/evaluated/<input_basename>.evaluation-state.json
```

用于断点续跑和进度追踪。

同一个 input 文件不能并行评估。

执行前必须检查：

```text
<workdir>/evaluated/<input_basename>.evaluation.lock
```

如果 lock 文件存在，或 state 中 `status` 是 `in_progress`，必须停止并报告：

```text
当前输入文件正在评估中，不能重复启动。
```

不要排队，不要强行覆盖，不要并行启动第二个评估进程。

结构示例：

```json
{
  "run_id": "2026-05-31_151743_feishu_hire",
  "input_file": "workspace/collected/2026-05-31_151743_feishu_hire.json",
  "output_file": "workspace/evaluated/2026-05-31_151743_feishu_hire.evaluated.json",
  "status": "completed",
  "total": 3,
  "completed": 3,
  "failed": 0,
  "updated_at": "2026-05-31T16:00:00+08:00"
}
```

判断完成：

```text
completed + failed == total
```

Lock 文件规则：

- 开始评估前创建 lock 文件。
- 评估完成后删除 lock 文件。
- fatal error 或进程异常退出时保留 lock 文件，不要自动删除；必须报告给用户人工确认。
- 不同 input 文件可以分别评估，但同一个 input 文件不能同时评估两次。

## 输出校验

模型输出必须校验。

合法 `score` 值：

- 0-10 的整数。
- 0 表示信息不足，无法判断。

如果模型输出不是合法 JSON，或者字段缺失，本条评估视为失败。

当前模型调用只执行一次。模型输出不合法时，该候选人写为：

```json
{
  "score": 0,
  "match_points": "",
  "risk_points": "无法评估：模型输出格式错误"
}
```

## 错误规则

Fatal error：

- 输入 JSON 不存在或无法解析。
- 输入 JSON 不是 collected JSON 结构。
- 无法读取评估标准表。
- 模型 API 配置缺失。

Fatal error 时可以写错误状态，但不能生成成功的 evaluated JSON。

非 fatal error：

- 单个候选人缺少岗位。
- 单个候选人找不到评估标准。
- 单个候选人模型调用失败。
- 单个候选人输出校验失败。

非 fatal error 不阻止其他候选人继续评估。

## 安全规则

- 执行前必须确认本次只做本地评估输出，不写飞书结果表。
- 只允许读取 collected JSON、读取飞书评估标准表、调用模型 API。
- 只允许写 `<workdir>/evaluated/` 下的 evaluated JSON、evaluation-state JSON 和 evaluation lock 文件。
- 不要修改 collected JSON。
- 不要把模型 API key、飞书 token、secret 写入输出文件。
- 不要把完整 prompt 写入 evaluated JSON，除非用户明确要求调试。
