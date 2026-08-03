/**
 * Versioned, data-only Portfolio V2 template.  A template task describes
 * historical facts and an execution recommendation; it never contains a
 * fake Run.  Imported history is materialized as Evidence + CompletionRecord
 * by the application service.
 */
export const PORTFOLIO_TEMPLATE_KEY = 'portfolio-v2-real-projects';
export const PORTFOLIO_TEMPLATE_VERSION = '2026-08-03.5';
export const PORTFOLIO_V2_TEMPLATE_KEY = PORTFOLIO_TEMPLATE_KEY;
export const PORTFOLIO_V2_TEMPLATE_VERSION = PORTFOLIO_TEMPLATE_VERSION;

export function getPortfolioV2Template() {
  return structuredClone(TEMPLATE);
}

const TEMPLATE = [
  project('Lifeline', '项目再多，也知道下一步该推什么',
    '把优先级、阶段、算力和验收放进同一张进度图。强算力集中攻坚，低算力持续清理 Bug，重要项目不会再被遗忘。',
    'https://github.com/qzhqzh/Lifeline', 10, true, [
      task('明确控制平面优先的产品边界与 ADR', '固化控制平面优先的边界、证据和安全约束。', 1, 1, 'VERIFIED', 'feature', 'P0', 'LOW-SCAN', history('5fb358b', 'docs/adr/0001-control-plane-first.md')),
      task('建立 Project、WorkItem、Run、Evidence 与状态机', '建立可验证的项目、任务、运行和证据基础模型。', 1, 2, 'VERIFIED', 'feature', 'P0', 'LUNA-CODE', history('dcf6b13', 'src/domain.js')),
      task('实现原子 JSON 持久化、恢复和重复排队保护', '让工作流检查点可持久化、恢复并避免重复排队。', 1, 3, 'VERIFIED', 'feature', 'P0', 'LUNA-CODE', history('dcf6b13', 'src/store.js')),
      task('跑通 Mock Executor、REST、SSE 与 Run Replay', '完成首个可回放的证据驱动执行纵向切片。', 1, 4, 'VERIFIED', 'feature', 'P0', 'LUNA-CODE', history('dcf6b13', 'test/vertical-slice.test.js')),
      task('实现 Project × Phase × Task 组合大板', '以项目为行、阶段为序展示推进中的任务。', 2, 1, 'VERIFIED', 'feature', 'P0', 'LUNA-CODE', history(null, 'docs/IMPLEMENTATION_STATUS.md')),
      task('修复旧数据载入与前后端版本不一致报错', '确保旧状态可读并在版本不一致时给出可追溯结果。', 2, 2, 'CANCELLED', 'bug', 'P0', 'LUNA-MEDIUM', history(null, 'test/vertical-slice.test.js')),
      task('导入三个真实项目和每用户一次性 receipt', '把真实项目、Phase、历史 Task 和一次性初始化事实写入服务端。', 2, 3, 'VERIFIED', 'feature', 'P0', 'LUNA-CODE', history(null, 'test/portfolio-v2.test.js')),
      task('让项目价值更清晰，创建入口更简单', '让用户先看懂每个项目解决什么问题，并从一个入口完成创建。', 2, 4, 'VERIFIED', 'feature', 'P1', 'LUNA-MEDIUM', history(null, 'public/app.js')),
      task('固定项目栏、稳定筛选、当前节点居中', '在长排期中保持项目栏、筛选结构和当前节点稳定。', 3, 1, 'VERIFIED', 'feature', 'P0', 'LUNA-CODE', history(null, 'public/app.js')),
      task('展开项目全部任务并支持键盘/拖拽排序', '展开项目查看完整任务清单，并补齐键盘排序、跨阶段预览与撤销。', 3, 2, 'VERIFIED', 'feature', 'P1', 'LUNA-CODE', history(null, 'test/ui-form.test.js')),
      task('加入依赖校验与可并行任务展示', '校验依赖关系并展示可并行的任务槽位。', 3, 3, 'VERIFIED', 'feature', 'P1', 'LUNA-CODE', history(null, 'test/dependency-schedule.test.js')),
      task('提供 Project/Phase/Task 查询与创建 MCP', '让 Agent 可以通过 MCP 查询和创建项目、阶段与任务。', 4, 1, 'VERIFIED', 'feature', 'P1', 'LUNA-CODE', history(null, 'test/mcp.test.js')),
      task('补齐扫描提案与指纹去重 MCP', '让扫描发现以可去重提案进入复核门禁。', 4, 2, 'VERIFIED', 'feature', 'P1', 'LUNA-CODE', history(null, 'test/scan-proposal.test.js')),
      task('接入 Streamable HTTP、OAuth 与多用户隔离', '让远程 Agent 在最小权限和真实用户边界下安全调用 MCP。', 4, 3, 'DEFERRED', 'ops', 'P1', 'INDEPENDENT-REVIEW'),
      task('周期扫描仓库并去重生成 Bug 候选', '周期扫描仓库并按 fingerprint 去重生成 Bug 候选。', 5, 1, 'RECURRING', 'scan', 'P2', 'LOW-SCAN'),
      task('Agent 完成后自动进入复核并更新项目进度', 'Agent 回报完成后先进入 REVIEW，经证据核验再更新进度。', 5, 2, 'VERIFIED', 'feature', 'P1', 'INDEPENDENT-REVIEW', history(null, 'test/mcp.test.js')),
      task('建立端到端浏览器回归与发布门禁', '把桌面、移动端、拖拽与危险操作纳入可重复的发布验收。', 6, 1, 'DEFERRED', 'review', 'P0', 'INDEPENDENT-REVIEW'),
      task('迁移 PostgreSQL Repository 并完成恢复演练', '在保持现有领域契约的前提下升级多用户持久层并验证备份恢复。', 6, 2, 'DEFERRED', 'ops', 'P1', 'LUNA-CODE'),
      task('接入 Temporal、真实 Executor 与模型路由', '让任务调度、执行、重试和模型选择进入可回放的生产链路。', 6, 3, 'DEFERRED', 'feature', 'P1', 'LUNA-CODE'),
      task('迁移 React 应用并完成灰度切换', '在交互契约稳定后迁移生产前端并保留回滚路径。', 6, 4, 'DEFERRED', 'ops', 'P2', 'LUNA-CODE')
    ]),
  project('EchoMe', '换一个 AI，工作也能接着往下做',
    '让偏好、规则和项目背景跟着你流转。AI 先理解你，再开始工作，少重复解释，也少因上下文丢失返工。',
    'https://github.com/qzhqzh/EchoMe', 9, false, [
      task('完成架构、记忆模型、API/MCP 规范与路线图', '固化跨 AI 记忆的产品边界和接口契约。', 1, 1, 'VERIFIED', 'feature', 'P0', 'LOW-SCAN', history('769a7b9', 'README.md')),
      task('建立 Hub、CLI、MCP Server 与迁移骨架', '让记忆服务、命令行和 MCP 可以被稳定调用。', 1, 2, 'VERIFIED', 'feature', 'P0', 'LUNA-CODE', history('8bb8a9b', 'bd25ae7')),
      task('建立 Vue Web Console 与 Docker 部署入口', '提供可操作的记忆控制台和本地部署路径。', 1, 3, 'VERIFIED', 'feature', 'P1', 'LUNA-CODE', history('a8c03ca', '4b7aa99')),
      task('完成多用户认证、数据隔离与 Market', '建立多用户边界和可治理的记忆市场。', 2, 1, 'VERIFIED', 'feature', 'P0', 'LUNA-CODE', history('efbf6aa', '232387f')),
      task('完成管理、速率限制、安全加固与多语言体验', '让服务具备可运营的安全与管理能力。', 2, 2, 'VERIFIED', 'bug', 'P1', 'LUNA-MEDIUM', history('29d2372', 'd773abc')),
      task('建立 PyPI、CI/CD、doctor/version 并发布 v1.0', '将核心能力打包、验证并发布首个稳定版本。', 2, 3, 'RELEASED', 'ops', 'P1', 'LUNA-MEDIUM', history('v1.0.0', 'v1.0.1')),
      task('默认分发 MCP、增加 seed 并完成 v1.1.x 稳定修复', '降低首次接入成本并收敛稳定性问题。', 3, 1, 'RELEASED', 'feature', 'P1', 'LUNA-MEDIUM', history('c79cd88', 'v1.1.7')),
      task('建立 summary-first 检索工作流', '让检索先用摘要筛选，再按需读取全文。', 3, 2, 'RELEASED', 'feature', 'P1', 'LUNA-CODE', history('f720805', 'v1.2.0')),
      task('完成 Memory Sleep 与可观测性', '让记忆休眠、唤醒和检索链路可以解释和监控。', 3, 3, 'RELEASED', 'feature', 'P1', 'LUNA-CODE', history('824fc64', 'v1.3.0')),
      task('增加 graph explain、feedback 和 retrieval debug', '支持记忆关系解释、反馈和检索调试。', 4, 1, 'VERIFIED', 'feature', 'P1', 'LUNA-CODE', history('7bff05d', '3f0c91d')),
      task('增加图工具、能力指南并改善检索相关性', '提高跨项目记忆检索的命中质量。', 4, 2, 'VERIFIED', 'research', 'P2', 'LUNA-MEDIUM', history('53745f9', '1730bfe')),
      task('建立 Artifact 修订、Constraint 版本和影响关系', '让项目知识变更有版本、约束和影响追踪。', 5, 1, 'PLANNED', 'feature', 'P0', 'LUNA-CODE', history(null, 'docs/project-knowledge.md')),
      task('完成 Project Workspace、MCP context/impact/index 闭环', '把项目知识工作区接入检索和影响分析。', 5, 2, 'PLANNED', 'feature', 'P0', 'LUNA-CODE'),
      task('完成迁移、回归、文档同步与发布评审', '在工作区实现稳定后完成迁移和发布复核。', 5, 3, 'PLANNED', 'review', 'P1', 'INDEPENDENT-REVIEW'),
      task('建立固定检索评测集和版本间回归报告', '用真实查询样本持续衡量记忆命中质量。', 6, 1, 'PLANNED', 'research', 'P2', 'LOW-SCAN')
    ]),
  project('Totemora', '把复杂工作，交给一支会协作的 AI 团队',
    '强模型负责判断，专长成员并行执行，过程、成本和结果全程可追踪。少盯过程，也能稳定拿到可验收的结果。',
    'https://github.com/qzhqzh/Totemora', 8, false, [
      task('固化产品边界与 TUI/Runtime/Web Observatory 路线', '明确部落运行时、终端和观察面的演进边界。', 1, 1, 'VERIFIED', 'feature', 'P0', 'LOW-SCAN', history('104130a', 'ADR-0001')),
      task('建立 Bun workspace 与配置类型、loader、validation', '建立可验证的 workspace 和配置加载基础。', 1, 2, 'VERIFIED', 'feature', 'P0', 'LUNA-CODE', history('040a4e9', '67c6d48')),
      task('加入示例 tribe 和 CLI inspection 命令', '让示例部落和运行状态可通过 CLI 检查。', 1, 3, 'VERIFIED', 'feature', 'P1', 'LUNA-MEDIUM', history('d1de960', '4d6d579')),
      task('建立 Provider、只读 Runtime、Trace 和任务分析', '把成员、运行和任务分析接入统一 runtime。', 2, 1, 'VERIFIED', 'feature', 'P0', 'LUNA-CODE', history('v0.2', 'v0.3')),
      task('建立常驻 Gateway、Web Playground 与持续任务入口', '提供常驻网关、可视化 playground 和持续任务入口。', 2, 2, 'VERIFIED', 'feature', 'P0', 'LUNA-CODE', history('4d2f97', 'ADR-0002')),
      task('完成受控 Git Flow 专业服务与 MCP 提案闭环', '将受控变更和 MCP 提案接入可审计流程。', 2, 3, 'VERIFIED', 'feature', 'P1', 'LUNA-CODE', history('4d2f97', 'v0.5 E2E')),
      task('建立 Living Tribe Member 和 Intelligence Watch', '让成员画像和情报观察可以持续更新。', 3, 1, 'VERIFIED', 'feature', 'P1', 'LUNA-CODE', history('ab7b65c', 'docs')),
      task('建立任务历史、成员画像与可归因经验', '保留任务历史和成员成长证据。', 3, 2, 'VERIFIED', 'research', 'P1', 'LUNA-CODE', history(null, 'v0.6/v0.8')),
      task('完成候选情报管线、Bark 派发与反馈校正', '把候选情报、通知和反馈校正串成闭环。', 4, 1, 'VERIFIED', 'feature', 'P1', 'LUNA-CODE', history('08552ec', 'ADR-0009/0012')),
      task('完成人物画像、受治理演化与专业服务', '支持人物画像、治理演化和专业化服务。', 4, 2, 'VERIFIED', 'feature', 'P1', 'LUNA-CODE', history('b61396e', 'ADR-0010/0011')),
      task('将 JSON 状态迁移到 SQLite 持久层', '把持久化状态迁移到 SQLite 并保持可恢复。', 4, 3, 'VERIFIED', 'ops', 'P0', 'LUNA-CODE', history('e9b062a', 'v0.9 验收指南')),
      task('增加 Web Observatory v2 与 benchmark CLI 骨架', '扩展观察面和 benchmark 命令骨架。', 4, 4, 'VERIFIED', 'feature', 'P1', 'LUNA-MEDIUM', history('89d474b', 'ff7b949')),
      task('跑通 3 个只读 smoke benchmark', '用 smoke benchmark 证明部落运行链路可复现。', 5, 1, 'VERIFIED', 'scan', 'P1', 'LOW-SCAN', history(null, 'docs/benchmark.md')),
      task('扩展为 10–20 个真实任务和稳定价格快照', '补充真实样本和价格快照，形成可比较基线。', 5, 2, 'READY', 'research', 'P1', 'LOW-SCAN'),
      task('增加代码变更类隔离 scorer', '建立隔离 scorer 评估代码变更任务。', 5, 3, 'PLANNED', 'feature', 'P1', 'LUNA-CODE'),
      task('对比单强、单廉价、部落三策略并作停止/继续决策', '在完整 benchmark 后做策略决策。', 5, 4, 'PLANNED', 'review', 'P0', 'HUMAN-DECISION'),
      task('统一命令策略、pre/post hooks、OS sandbox 与 action journal', '收紧受控执行边界并保留每次动作日志。', 6, 1, 'PLANNED', 'ops', 'P1', 'LUNA-CODE')
    ])
];

function project(name, headline, description, repositoryUrl, strategicValue, primary, workItems) {
  const phaseNames = {
    Lifeline: ['S1 建立可信控制平面', 'S2 看清所有项目', 'S3 稳定编辑排期', 'S4 开放 Agent 接口', 'S5 持续推进闭环', 'S6 生产化与可靠发布'],
    EchoMe: ['S1 让记忆跨 AI 接续', 'S2 成为可用的多人产品', 'S3 降低记忆使用成本', 'S4 让记忆可解释', 'S5 让项目知识可治理', 'S6 持续提高命中质量'],
    Totemora: ['S1 点燃第一支部落', 'S2 让部落真正接活', 'S3 让成员持续生活', 'S4 建立情报与成长闭环', 'S5 证明部落确有收益', 'S6 收紧受控执行']
  }[name] ?? [];
  for (const item of workItems) {
    item.planning.phase = phaseNames[item.planning.phaseOrder - 1] ?? item.planning.phase;
  }
  return {
    name,
    headline,
    description,
    repositoryUrl,
    strategicValue,
    primary,
    templateKey: PORTFOLIO_TEMPLATE_KEY,
    templateVersion: PORTFOLIO_TEMPLATE_VERSION,
    workItems
  };
}

function task(title, objective, phaseOrder, taskOrder, status, kind, priority, capability, source = null) {
  const recommendation = recommendationFor(capability);
  return {
    title,
    objective,
    acceptanceCriteria: [`${title} 具有可追溯结果或验收证据`],
    planning: {
      phase: phaseName(phaseOrder),
      phaseOrder,
      taskOrder,
      kind,
      priority,
      commitment: priority === 'P0' ? 'COMMITTED' : 'TENTATIVE'
    },
    recommendation,
    status,
    history: source
  };
}

function history(commitSha, artifactUri) {
  return {
    commitSha,
    artifactUris: artifactUri ? [artifactUri] : [],
    summary: '从项目历史导入；未生成伪造 Run。'
  };
}

function recommendationFor(capability) {
  const values = {
    'LOW-SCAN': { capability: 'repository-scan', executor: 'codex', reasoningEffort: 'low', compute: 'low', estimateMinutes: 20, approach: '先跑确定性命令，再汇总异常。' },
    'LUNA-CODE': { capability: 'agentic-coding', executor: 'codex', reasoningEffort: 'high', compute: 'high', estimateMinutes: 90, approach: '先确认执行契约与验收证据，再实现并独立审查。' },
    'LUNA-MEDIUM': { capability: 'agentic-coding', executor: 'codex', reasoningEffort: 'medium', compute: 'medium', estimateMinutes: 45, approach: '先缩小边界，再完成可验证的小批次。' },
    'INDEPENDENT-REVIEW': { capability: 'independent-review', executor: 'codex', reasoningEffort: 'high', compute: 'medium', estimateMinutes: 35, approach: '与实现上下文隔离复核并保留证据。' },
    'HUMAN-DECISION': { capability: 'human-decision', executor: 'human', reasoningEffort: 'high', compute: 'low', estimateMinutes: 30, approach: '整理证据后由用户确认取舍。' }
  };
  return { ...values[capability] ?? values['LUNA-CODE'], capability: values[capability]?.capability ?? 'agentic-coding' };
}

function phaseName(order) {
  return `阶段 ${order}`;
}
