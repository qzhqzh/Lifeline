# 测试治理与 Red-Green 工作流

Lifeline 将三类事实分开保存和展示：测试声明、Runner/coverage/mutation/质量工具的运行证据、以及尚未实现的期望场景。测试地图不把覆盖率合成单一总分，也不向客户展示模型名称、置信度或推荐分数。

## 证据管线

```text
Node.js / Python / JUnit 测试目录
  + TAP / JUnit
  + LCOV / Cobertura / JaCoCo / Node coverage
  + Stryker mutation
  + Playwright / axe / visual / k6 / deployment / security JSON
        ↓
test-evidence/v1
        ↓
八类质量事实、证据新鲜度、flake、quarantine、独立门禁
        ↓
测试地图真实站点 + 缺测/部分覆盖幽灵站点
```

通用导入示例：

```bash
npm run import:test-evidence -- \
  --test-report reports/junit.xml --test-format junit \
  --coverage-report reports/jacoco.xml --coverage-format jacoco \
  --mutation-report reports/mutation.json \
  --quality-report browser-e2e:reports/playwright.json \
  --quality-report accessibility-scan:reports/axe.json \
  --quality-report visual-regression:reports/visual.json \
  --quality-report load-test:reports/k6.json \
  --output data/test-evidence/project_id.json
```

质量证据缺失、失败或过期会保留为 `WARN/FAIL` 原因，不会被模型推断为通过。Stryker survivor 和重复运行出现通过/失败交替的测试会自动形成带来源的场景候选。

## 场景评审

每个 Proposal 必须至少引用一条源码、契约、需求、Issue、事故或 mutation 证据，并以稳定 fingerprint 去重：

```text
PROPOSED → REVIEW → ACCEPTED → TEST_DRAFT
                                  ↓
BASELINE 已通过 → COVERED_EXISTING（停止，不创建任务）
BASELINE 错误原因不符 → NEEDS_CORRECTION（停止，不创建任务）
BASELINE 因预期原因失败 → RED_PROVEN → IMPLEMENTING → GREEN → VERIFIED

REVIEW → DISMISSED / SUPPRESSED → REOPEN
```

只有匹配预期原因的 RED 证据才能幂等创建一个实施 Task。GREEN 仍需确定性测试、独立复核或负责人批准才能进入 VERIFIED。AI 可提交语义候选和内部分析版本，但所有对客户返回的 DTO 都移除这些内部字段。

测试地图右侧详情支持 Proposal Review 和生成最小测试草案；草案只返回文本，不自动写目标仓库。隔离运行由目标仓库主动执行：

只读客户仅查看场景与证据；Editor 可提交候选、生成草案和回写运行结果；Manager/Owner 才能评审，最终 `OWNER_APPROVAL` 仅限 Owner。

```bash
npm run run:test-scenario -- \
  --server http://localhost:8019 \
  --project <projectId> \
  --proposal <proposalId> \
  --stage baseline \
  --phase <phaseId> \
  --source-uri ci://pipeline/run-123 \
  --access-token <projectToken> \
  -- node --test test/scenario-example.test.js
```

脚本使用 `spawn(executable, args, { shell: false })`，Lifeline 服务端不执行仓库传入的任意命令。

## 跨项目适配

核心分析器和证据导入器是项目无关模块，Skill/MCP 只负责编排：

- `lifeline_list_test_scenario_proposals`
- `lifeline_propose_test_scenario`
- `lifeline_review_test_scenario`
- `lifeline_create_test_draft`
- `lifeline_record_test_scenario_run`
- `lifeline_verify_test_scenario`

确定性适配器优先处理目录、AST、状态机、OpenAPI/schema、调用与断言；语义分析只补跨模块业务含义。未变化文件继续使用分析器指纹缓存，分类修正不成为普通用户的必做步骤。
