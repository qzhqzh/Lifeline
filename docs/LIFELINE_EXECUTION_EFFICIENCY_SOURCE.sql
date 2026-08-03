-- Reviewed aggregate snapshot extracted from the formal Lifeline project.
-- Run with: sqlite3 :memory: ".read docs/LIFELINE_EXECUTION_EFFICIENCY_SOURCE.sql"

SELECT
  json_extract(document, '$.summary.plannedTotal') AS planned_total,
  json_extract(document, '$.summary.s3ToS5Planned') AS s3_to_s5_planned,
  ROUND(json_extract(document, '$.summary.runDurationMs') / 60000.0, 1) AS run_minutes,
  json_extract(document, '$.summary.inputTokensRecorded') AS input_token_records,
  json_extract(document, '$.summary.costRecorded') AS cost_records
FROM (
  SELECT json(readfile('docs/LIFELINE_EXECUTION_EFFICIENCY_SOURCE.json')) AS document
);

SELECT
  json_extract(value, '$.sequence') AS sequence,
  json_extract(value, '$.phase') AS phase,
  json_extract(value, '$.issue') AS issue,
  json_extract(value, '$.task') AS task,
  json_extract(value, '$.priority') AS priority,
  json_extract(value, '$.risk') AS risk,
  json_extract(value, '$.profile') AS proposed_validation_profile
FROM json_each(
  json(readfile('docs/LIFELINE_EXECUTION_EFFICIENCY_SOURCE.json')),
  '$.pending_tasks'
)
ORDER BY sequence;

SELECT
  json_extract(value, '$.task') AS task,
  json_extract(value, '$.executor') AS executor,
  ROUND(json_extract(value, '$.durationSec') / 60.0, 2) AS duration_min,
  json_extract(value, '$.status') AS status
FROM json_each(
  json(readfile('docs/LIFELINE_EXECUTION_EFFICIENCY_SOURCE.json')),
  '$.runs'
)
ORDER BY duration_min DESC;

WITH validation_profiles(
  sequence,
  profile,
  applies_to,
  task_gate,
  batch_gate,
  extra_gate
) AS (
  VALUES
    (0, 'V0 静态', '文案、说明、纯配置标签', '检查 diff、解析或语法', '无', '不重启、不浏览器、不复核'),
    (1, 'V1 定向', '局部低/中风险代码修复', '复现 + 受影响测试文件', '批次末一次完整 check', '默认不独立复核'),
    (2, 'V2 集成', 'API/MCP、状态语义、UI 交互', '定向合同或受影响交互', '一次完整 check + 一次重启', '浏览器只验受影响路径'),
    (3, 'V3 发布', '安全、迁移、权限、关键数据', '定向测试 + dry-run/失败路径', '完整 check + 重启/健康检查', '一次独立复核；按需全量浏览器')
)
SELECT *
FROM validation_profiles
ORDER BY sequence;
