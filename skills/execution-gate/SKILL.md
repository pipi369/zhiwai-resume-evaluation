---
name: execution-gate
description: Classify recruitment pipeline execution risk and require confirmation before external writes. 招聘自动化执行门禁：判断风险、强制 dry-run 默认值、外部写入前必须确认。
version: 0.1.0
owner: guan
updated: 2026-05-31
authority: required
---

# 执行门禁

## 目的

在运行任何招聘自动化动作前，先判断当前请求的风险等级。

只读、本地生成文件、本地评估可以继续执行。写飞书、改真实配置、改定时任务、改 memory 等动作必须先停下来问用户。

## 动作分类

无需确认即可执行：

- 读取本地仓库文件、Skill、文档、示例、模板和本地配置。
- 通过已配置的 CLI/API 读取飞书招聘、邮箱、多维表格数据。
- 在配置的 workspace 下生成本地 Excel、JSON、Markdown 报告、日志和写入预览。
- 评估候选人，并把结果写到本地 workspace 文件。

必须明确确认后才能执行：

- 新增、更新、删除飞书多维表格记录。
- 写入飞书招聘、邮箱或任何外部系统。
- 发送消息或通知。
- 修改真实本地配置，例如 `.local/pipeline.config.json`。
- 修改正常 pipeline 运行之外的 runtime 水位或状态。
- 创建、修改、删除定时任务。
- 修改 memory、凭证、secret 或 agent 级设置。
- 推送到 GitHub、创建 release、发布 Skill 更新。

必须停止并询问用户：

- 飞书 app、table、view 或字段映射不清楚。
- 时间范围、数据源、去重键或写回目标不清楚。
- 用户请求和当前配置模式冲突。
- 操作可能覆盖用户维护的文件。

## 定时任务规则

定时任务必须强制使用 preview-only 模式。

允许：

- 采集数据。
- 更新本地 pipeline workbook。
- 评估候选人。
- 生成 `write_preview`。
- 生成运行报告。
- 更新定时任务所需的本地水位。

禁止：

- live 写回飞书。
- 发送外部消息。
- 修改真实配置。
- 修改定时任务。
- 发布代码或 Skill 变更。

如果定时任务执行到需要确认的步骤，必须停在最近的安全产物，并把原因写入运行报告。

## 执行前报告

继续执行前，必须报告：

- 触发类型：manual 或 scheduled。
- 当前模式：dry-run、preview-only 或 live。
- 是否涉及外部写入。
- 当前 pipeline config 路径。
- 当前 workspace 路径。
- 当前飞书目标 app/table，如果已知。
- 本次可能写入的本地文件。

## 确认标准

只有当当前对话里出现了针对具体目标、具体 preview/run 的明确批准，才算用户确认 live write。

不能把泛泛的执行意图推断成写回确认。

