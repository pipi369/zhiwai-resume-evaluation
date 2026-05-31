# Zhiwai Resume Evaluation

招聘简历自动化流水线：从飞书招聘和邮箱采集候选人数据，按岗位评估标准调用大模型评估，写回飞书多维表格，并发送飞书群通知。

## 定时任务命令

给龙虾定时调用时，在仓库根目录执行：

```bash
node scripts/run-recruitment-pipeline.mjs --workdir workspace --writeback apply
```

这条命令会按固定顺序执行：

1. 采集飞书招聘渠道数据。
2. 采集邮箱渠道数据。
3. 对本轮新采集的数据执行评估。
4. 生成写回预览。
5. 写回飞书多维表格。
6. 写回成功后发送飞书群通知。

如果某个渠道本轮没有新候选人，会跳过该渠道的评估和写回。

## 本地配置

本地配置放在 `workspace/` 下，不提交到 Git。

```text
workspace/
  runtime-state.json
  evaluator-config.json
  writeback-config.json
```

`runtime-state.json` 记录各渠道采集水位。

`evaluator-config.json` 配置大模型和评估标准表。

`writeback-config.json` 配置写回目标表、字段映射和飞书机器人通知。

### runtime-state.json

首次运行可以不创建。脚本找不到历史水位时，会默认采集北京时间最近 1 小时的数据。

如果需要手动指定下次采集起点，可以创建或修改：

```json
{
  "collection": {
    "feishu_hire": {
      "last_success_at": "2026-05-29T18:00:00+08:00"
    },
    "email_resume": {
      "last_success_at": "2026-05-29T18:00:00+08:00"
    }
  }
}
```

字段说明：

- `collection.feishu_hire.last_success_at`：飞书招聘渠道下次采集的开始时间。
- `collection.email_resume.last_success_at`：邮箱渠道下次采集的开始时间。

脚本成功写入采集 JSON 后，会自动更新这个文件。

### evaluator-config.json

用于配置大模型和飞书评估标准表。

```json
{
  "model": {
    "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "api_key": "REPLACE_WITH_LLM_API_KEY",
    "model": "qwen-plus",
    "enable_thinking": false,
    "extra_options": {}
  },
  "criteria_table": {
    "app_token": "REPLACE_WITH_CRITERIA_APP_TOKEN",
    "table_id": "REPLACE_WITH_CRITERIA_TABLE_ID",
    "job_name_field": "岗位名称",
    "prompt_field": "评估提示词"
  },
  "evaluation": {
    "max_prompt_chars": 16000
  }
}
```

字段说明：

- `model.base_url`：OpenAI-compatible 接口地址。
- `model.api_key`：大模型 API Key。
- `model.model`：模型名称。
- `model.enable_thinking`：是否开启思考，当前固定建议 `false`。
- `model.extra_options`：模型厂商额外参数，没有就 `{}`。
- `criteria_table.app_token`：存放岗位评估标准的飞书多维表格 app token。
- `criteria_table.table_id`：评估标准表 table id。
- `criteria_table.job_name_field`：岗位名称列，固定用 `岗位名称`。
- `criteria_table.prompt_field`：评估提示词列，固定用 `评估提示词`。
- `evaluation.max_prompt_chars`：候选人资料拼进提示词的最大字符数。

评估标准表必须至少有两列：

```text
岗位名称
评估提示词
```

岗位名称必须和采集到的应聘岗位精准匹配。

### writeback-config.json

用于配置评估结果写回的目标表、字段映射和飞书机器人。

```json
{
  "target_table": {
    "app_token": "REPLACE_WITH_TARGET_APP_TOKEN",
    "table_id": "REPLACE_WITH_TARGET_TABLE_ID"
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
    "enabled": true,
    "webhook_url": "REPLACE_WITH_FEISHU_BOT_WEBHOOK_URL",
    "keyword": "招聘评估"
  }
}
```

字段说明：

- `target_table.app_token`：写回目标飞书多维表格 app token。
- `target_table.table_id`：写回目标表 table id。
- `field_mapping`：把评估结果里的英文字段映射到飞书目标表字段。
- `notification.enabled`：是否发送飞书群机器人通知。
- `notification.webhook_url`：飞书自定义机器人 webhook。
- `notification.keyword`：机器人关键词校验，建议固定 `招聘评估`。

目标写回表需要有这些字段：

```text
姓名
应聘岗位
来源渠道
简历接收日期
工作城市
简历反馈
简历匹配点
简历风险点
```

`简历接收日期` 应该是飞书日期字段，脚本会自动转换为飞书需要的时间戳。

飞书机器人配置建议：

1. 在飞书群添加自定义机器人。
2. 安全设置选择关键词。
3. 关键词填写 `招聘评估`。
4. 复制 webhook 到 `notification.webhook_url`。
5. 设置 `notification.enabled=true`。

## 主要脚本

```text
scripts/collect-recruitment-data.mjs
scripts/evaluate-recruitment-data.mjs
scripts/writeback-evaluation-results.mjs
scripts/run-recruitment-pipeline.mjs
```

日常定时任务只需要调用 `run-recruitment-pipeline.mjs`，不要拆开执行子脚本。

## Skills

```text
skills/recruitment-data-collector/
skills/recruitment-evaluator/
skills/recruitment-writeback/
skills/recruitment-pipeline-orchestrator/
```

龙虾执行完整定时链路时，使用 `recruitment-pipeline-orchestrator`。

## 输出目录

```text
workspace/
  collected/       # 采集结果
  evaluated/       # 评估结果
  write-preview/   # 写回预览
  write-result/    # 写回结果
  pipeline-runs/   # 编排运行结果
```

## 写回通知

写回 apply 完成后，如果 `workspace/writeback-config.json` 中启用了机器人通知，会发送类似：

```text
招聘评估写回已执行
渠道：飞书招聘

评估结果：
一共：3
推荐：2
待 HR 确认：0
不推荐：1
信息不足/其他：0
```

## 注意事项

- `workspace/` 是本地运行数据目录，不提交 Git。
- 飞书 app secret、大模型 key、机器人 webhook 只放本地配置，不写入仓库。
- 评估标准从飞书多维表格读取，按岗位名称精准匹配。
- 候选人唯一键由采集脚本生成：飞书渠道使用候选人 ID + 岗位，邮箱渠道使用岗位 + 姓名。
