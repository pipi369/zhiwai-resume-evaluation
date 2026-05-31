---
name: resume-evaluator
description: Evaluate one resume against position criteria and return normalized recruitment feedback fields. 单份简历评估：根据岗位标准输出简历反馈、匹配点和风险点。
version: 0.1.0
owner: guan
updated: 2026-05-31
authority: evaluation-only
---

# 单份简历评估

## 目的

针对一个候选人和一个岗位标准完成简历评估，输出后续 Excel 和飞书写回可直接使用的结构化反馈。

## 输入

必需：

- 候选人的 `eval_input`。
- 岗位名称或岗位 ID。
- 由 `resume-evaluation-runner` 选定的 criteria 文本或 criteria 文件。

可选：

- 候选人展示字段。
- 飞书招聘或邮箱来源上下文。
- 职位 JD 详情。

## 输出字段

必须只返回这些业务字段：

- `简历反馈`
- `简历匹配点`
- `简历风险点`

`简历反馈` 合法值：

- `推荐面试`
- `待HR确认`
- `不推荐`
- `信息不足`

## 评估规则

- 结论只能基于提供的候选人信息和岗位标准。
- 当简历证据不足以可靠判断时，使用 `信息不足`。
- 有潜在匹配但需要 HR 核实时，优先使用 `待HR确认`。
- 匹配点和风险点必须具体、基于证据，并适合 HR 阅读。
- 不要推断敏感个人属性。
- 不要编造工作经历、技能、教育、薪资、到岗时间或求职意向。

## 输出契约

返回：

```json
{
  "简历反馈": "推荐面试 | 待HR确认 | 不推荐 | 信息不足",
  "简历匹配点": "string",
  "简历风险点": "string"
}
```

如果评估失败，返回：

```json
{
  "简历反馈": "信息不足",
  "简历匹配点": "",
  "简历风险点": "无法评估：<reason>"
}
```

## 边界

这个 Skill 不负责：

- 读取或写入飞书。
- 直接修改 Excel。
- 在多个岗位映射同时命中时自行选择。
- 判断结果是否应该写回外部系统。

