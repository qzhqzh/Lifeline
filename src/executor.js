const DEFAULT_STEPS = Object.freeze([
  {
    key: 'plan',
    label: 'Execution contract analyzed',
    evidence: { type: 'PLAN', score: 0.15, summary: 'Execution plan and contract validated' }
  },
  {
    key: 'branch',
    label: 'Isolated feature branch prepared',
    evidence: { type: 'BRANCH', score: 0.35, summary: 'Isolated implementation branch created' }
  },
  {
    key: 'test',
    label: 'Acceptance test command completed',
    evidence: { type: 'TEST', score: 0.6, summary: 'Configured test command passed' }
  },
  {
    key: 'review',
    label: 'Independent review completed',
    evidence: { type: 'REVIEW', score: 0.8, summary: 'Independent review gate passed' }
  }
]);

export class MockExecutor {
  constructor({ delayMs = 80 } = {}) {
    this.delayMs = Math.max(0, Number(delayMs) || 0);
  }

  get stepCount() {
    return DEFAULT_STEPS.length;
  }

  async executeStep(index, workItem) {
    const step = DEFAULT_STEPS[index];
    if (!step) throw new Error(`Unknown mock executor step: ${index}`);
    await delay(this.delayMs);

    const shouldFail = /\[fail(?::([^\]]+))?\]/i.exec(`${workItem.title} ${workItem.objective}`);
    const requestedFailureStep = shouldFail?.[1]?.toLowerCase() ?? 'test';
    if (shouldFail && requestedFailureStep === step.key) {
      const error = new Error(`Simulated ${step.key} failure requested by work item`);
      error.code = 'SIMULATED_EXECUTOR_FAILURE';
      throw error;
    }

    return {
      step: step.key,
      message: step.label,
      evidence: {
        ...step.evidence,
        metadata: {
          executor: 'mock',
          step: step.key,
          testCommands: step.key === 'test' ? workItem.testCommands : undefined
        }
      }
    };
  }
}

function delay(milliseconds) {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
