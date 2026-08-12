(function startCollector() {
  const adapter = globalThis.LifelineSubscriptionAdapters;
  if (!adapter?.isSupportedQuotaPage(location.href)) return;
  let timer = null;

  function collect() {
    const sourceUrl = adapter.sanitizeSourceUrl(location.href);
    try {
      const result = adapter.collect(sourceUrl, quotaPageText(resultProvider(sourceUrl)));
      chrome.runtime.sendMessage({ type: 'SUBSCRIPTION_SNAPSHOT', sourceUrl, result });
    } catch (error) {
      chrome.runtime.sendMessage({
        type: 'SUBSCRIPTION_SNAPSHOT_ERROR',
        sourceUrl,
        provider: adapter.providerFor(sourceUrl),
        adapterVersion: adapter.ADAPTER_VERSION,
        error: { code: 'ADAPTER_PARSE_FAILED', message: String(error?.message ?? error).slice(0, 300) }
      });
    }
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(collect, 1200);
  }

  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  collect();
  setInterval(collect, 5 * 60 * 1000);

  function resultProvider(sourceUrl) {
    return adapter.providerFor(sourceUrl);
  }

  function quotaPageText(provider) {
    const selectors = {
      CODEX: ['main', '[data-testid*="usage"]'],
      GEMINI: ['[data-test-id*="usage"]', '[data-testid*="usage"]', '[aria-label*="Usage"]', '[aria-label*="用量"]', '[role="dialog"]'],
      CURSOR: ['main', '[data-testid*="usage"]'],
      GROK: ['main'],
      XIAOYUNQUE: ['[data-testid*="credit"]', '[data-testid*="point"]', '[class*="credit"]', '[class*="point"]', '[aria-label*="积分"]', '[aria-label*="余额"]']
    }[provider] ?? [];
    const candidates = selectors
      .flatMap((selector) => [...document.querySelectorAll(selector)])
      .map((node) => node.innerText ?? '')
      .filter(Boolean);
    const text = candidates.filter((value) => (
      provider === 'GEMINI'
        ? /usage\s+limits?|使用限额|额度|重置/i.test(value)
        : provider === 'XIAOYUNQUE'
          ? /积分|点数|余额|会员/i.test(value)
          : true
    )).join('\n').slice(0, 50_000);
    if (!text) throw new Error('QUOTA_COMPONENT_NOT_FOUND');
    return text;
  }
})();
