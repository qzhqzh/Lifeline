(function registerAdapters(global) {
  const ADAPTER_VERSION = 'subscription-dom-v2';

  function collect(url, text) {
    const provider = providerFor(url);
    if (!provider) throw new Error('UNSUPPORTED_PROVIDER');
    const normalized = normalizeText(text);
    const parser = {
      CODEX: parseCodex,
      GEMINI: parseGemini,
      CURSOR: parseCursor,
      GROK: parseGrok,
      XIAOYUNQUE: parseXiaoyunque
    }[provider];
    const result = parser(normalized);
    return { provider, adapterVersion: ADAPTER_VERSION, ...result };
  }

  function providerFor(value) {
    const hostname = new URL(value).hostname;
    if (hostname === 'chatgpt.com') return 'CODEX';
    if (hostname === 'gemini.google.com') return 'GEMINI';
    if (hostname === 'cursor.com' || hostname === 'www.cursor.com') return 'CURSOR';
    if (['grok.com', 'www.grok.com', 'x.com', 'www.x.com'].includes(hostname)) return 'GROK';
    if (hostname === 'xyq.jianying.com') return 'XIAOYUNQUE';
    return null;
  }

  function isSupportedQuotaPage(value) {
    const url = new URL(value);
    const provider = providerFor(value);
    if (provider === 'CODEX') return url.pathname === '/codex/settings/usage';
    if (provider === 'CURSOR') return url.pathname === '/dashboard';
    if (provider === 'GEMINI') return url.pathname === '/app';
    if (provider === 'XIAOYUNQUE') return url.pathname === '/home';
    if (provider === 'GROK') {
      return /^\/(?:settings|account|usage)(?:\/|$)/.test(url.pathname)
        || /^\/i\/(?:premium|grok\/settings)(?:\/|$)/.test(url.pathname);
    }
    return false;
  }

  function sanitizeSourceUrl(value) {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  }

  function parseCodex(text) {
    const measurements = [];
    pushPercent(measurements, text, 'codex_5h', '5 小时窗口', /(?:5[- ]?hour|5\s*小时)[^\n]{0,100}/gi, '5h');
    pushPercent(measurements, text, 'codex_weekly', '每周窗口', /(?:week(?:ly)?|每周|本周)[^\n]{0,100}/gi, 'weekly');
    const credits = explicitNumber(text, /(?:codex\s+)?credits?/i);
    if (credits !== null) measurements.push(metric('codex_credits', '额外 Credits', 'credit_balance', {
      remaining: credits,
      unit: 'credits',
      sourceKind: 'SCOPED_DOM',
      confidence: 'MEDIUM'
    }));
    return finalize(text, measurements, 'Codex 当前页面可访问');
  }

  function parseGemini(text) {
    const measurements = [];
    pushPercent(measurements, text, 'gemini_5h', '5 小时窗口', /(?:5[- ]?hour|5\s*小时)[^\n]{0,100}/gi, '5h');
    pushPercent(measurements, text, 'gemini_weekly', '每周窗口', /(?:week(?:ly)?|每周|本周)[^\n]{0,100}/gi, 'weekly');
    pushPercent(measurements, text, 'gemini_pro', 'Pro 模型额度', /(?:gemini\s+)?pro[^\n]{0,100}/gi, null);
    return finalize(text, measurements, 'Google AI Pro 当前页面可访问');
  }

  function parseCursor(text) {
    const measurements = [];
    pushUsagePool(measurements, text, 'cursor_models', 'Cursor Models', /cursor\s+models?[^\n]{0,120}/gi);
    pushUsagePool(measurements, text, 'other_models', 'Other Models', /other\s+models?[^\n]{0,120}/gi);
    return finalize(text, measurements, 'Cursor 当前页面可访问');
  }

  function parseGrok(text) {
    const measurements = [];
    pushPercent(measurements, text, 'grok_usage', 'Grok 使用窗口', /(?:grok|usage|用量)[^\n]{0,100}/gi, null);
    return finalize(text, measurements, 'Grok 当前页面可访问');
  }

  function parseXiaoyunque(text) {
    return finalize(text, [], '小云雀页面可访问，数值待校准');
  }

  function finalize(text, measurements, availabilityLabel) {
    const limited = /(usage\s+limit\s+(?:reached|exceeded)|reached\s+(?:your\s+)?(?:usage\s+)?limit|额度(?:已)?用(?:完|尽)|已达到[^\n]{0,12}上限|使用次数已用完)/i.test(text);
    const login = /(登录|sign\s*in|log\s*in)[^\n]{0,40}(?:验证码|account|账号|phone|手机号)/i.test(text);
    if (measurements.length === 0) measurements.push(metric('availability', availabilityLabel, 'availability', { resetsAt: explicitResetAt(text) }));
    return {
      reportedStatus: limited ? 'LIMITED' : login ? 'UNKNOWN' : 'AVAILABLE',
      measurements
    };
  }

  function pushPercent(target, text, key, label, contextPattern, windowName) {
    const contexts = text.match(contextPattern) ?? [];
    for (const context of contexts) {
      const ratio = explicitRemainingRatio(context);
      if (ratio === null) continue;
      target.push(metric(key, label, 'quota_window', {
        remainingRatio: ratio,
        remaining: ratio * 100,
        limit: 100,
        unit: '%',
        window: windowName,
        resetsAt: explicitResetAt(context),
        reliableLimit: true,
        sourceKind: 'SCOPED_DOM',
        confidence: 'MEDIUM'
      }));
      return;
    }
  }

  function pushUsagePool(target, text, key, label, contextPattern) {
    const contexts = text.match(contextPattern) ?? [];
    for (const context of contexts) {
      const pair = /\$?([0-9][\d,.]*)\s*(?:used)?\s*(?:\/|of)\s*\$?([0-9][\d,.]*)/i.exec(context);
      if (!pair) continue;
      const used = number(pair[1]);
      const limit = number(pair[2]);
      if (used === null || limit === null || limit <= 0 || used > limit) continue;
      target.push(metric(key, label, 'usage_pool', {
        used,
        limit,
        remaining: limit - used,
        remainingRatio: (limit - used) / limit,
        unit: '$',
        window: 'billing_cycle',
        reliableLimit: true,
        sourceKind: 'SCOPED_DOM',
        confidence: 'MEDIUM'
      }));
      return;
    }
  }

  function explicitRemainingRatio(value) {
    const after = /([0-9]{1,3}(?:\.[0-9]+)?)\s*%\s*(?:remaining|left|剩余)/i.exec(value);
    const before = /(?:remaining|left|剩余)[^\d%]{0,20}([0-9]{1,3}(?:\.[0-9]+)?)\s*%/i.exec(value);
    const result = number((after ?? before)?.[1]);
    if (result !== null && result <= 100) return result / 100;
    const used = number(/([0-9]{1,3}(?:\.[0-9]+)?)\s*%\s*(?:used|已用|使用)/i.exec(value)?.[1]);
    return used !== null && used <= 100 ? (100 - used) / 100 : null;
  }

  function explicitNumber(text, labelPattern) {
    const lines = text.split('\n').filter((line) => labelPattern.test(line));
    for (const line of lines) {
      labelPattern.lastIndex = 0;
      const match = /(?:remaining|left|剩余|余额|积分|credits?|点数)[^\d]{0,24}([0-9][\d,.]*)|([0-9][\d,.]*)[^\d]{0,12}(?:credits?|积分|点数)/i.exec(line);
      const value = number(match?.[1] ?? match?.[2]);
      if (value !== null) return value;
    }
    return null;
  }

  function explicitResetAt(text) {
    const match = /(?:reset\s+at|resets?|重置(?:时间)?)[^\n\dA-Za-z]{0,12}((?:20\d{2}[-/]\d{1,2}[-/]\d{1,2}|[A-Z][a-z]{2,8}\s+\d{1,2},?\s+20\d{2})[^\n]{0,24})/i.exec(text);
    if (!match) return null;
    const parsed = Date.parse(match[1]);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }

  function metric(key, label, kind, values = {}) {
    return {
      key,
      label,
      kind,
      unit: values.unit ?? null,
      used: values.used ?? null,
      limit: values.limit ?? null,
      remaining: values.remaining ?? null,
      remainingRatio: values.remainingRatio ?? null,
      window: values.window ?? null,
      resetsAt: values.resetsAt ?? null,
      reliableLimit: values.reliableLimit === true,
      sourceKind: values.sourceKind ?? 'STATUS_INFERENCE',
      confidence: values.confidence ?? 'LOW'
    };
  }

  function number(value) {
    if (value === undefined || value === null) return null;
    const parsed = Number(String(value).replaceAll(',', ''));
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }

  function normalizeText(value) {
    return String(value ?? '').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  }

  global.LifelineSubscriptionAdapters = Object.freeze({
    collect,
    providerFor,
    isSupportedQuotaPage,
    sanitizeSourceUrl,
    ADAPTER_VERSION
  });
})(globalThis);
