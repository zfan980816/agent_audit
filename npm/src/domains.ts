// Known-agent domain registry (M5 watch mode).
//
// Ground truth: docs/superpowers/research/2026-09-20-zcode-forensics.md
// section 4 (domain inventory, grep of app.asar/zcode.cjs + observed DNS
// cache entries) plus the provider registry quoted there. A handful of
// well-known endpoints for OTHER audited tools (Claude Code / Codex / Gemini
// CLI) are marked in their notes as "not in research docs" — kept few and
// labeled so the registry stays honest about its sources.
//
// IP ranges are deliberately NOT classified (aliyuncs & friends are too
// broad): connections whose IP never maps to a hostname inside the watch
// window are reported as category "unknown" with a DNS note. Report what we
// know — no guessing.

export interface DomainRule {
  // String semantics:
  //   "host.tld"        -> exact hostname match (after lowercasing)
  //   "*.host.tld"      -> host.tld itself OR any subdomain of it
  // RegExp semantics: .test() against the lowercased host.
  match: string | RegExp;
  category: string;
  // Source/purpose note; every rule carries one so the registry is
  // self-documenting and `--list` style inspection stays honest.
  note: string;
}

// Summary/terminal ordering; "unknown" is rendered last (and alerted).
export const CATEGORY_ORDER = [
  "model-api",
  "telemetry",
  "update",
  "captcha",
  "community",
  "unknown",
] as const;

export type DomainCategory = (typeof CATEGORY_ORDER)[number];

export interface ClassifyResult {
  category: string;
  note?: string;
}

export const DOMAIN_RULES: readonly DomainRule[] = [
  // ---- model-api: endpoints that carry prompts/code context (product use) ----
  { match: "zcode.z.ai", category: "model-api", note: "ZCode main backend: client/agent configs, billing, zcode-plan model endpoints (forensics doc 4.1, hardcoded)" },
  { match: "api.z.ai", category: "model-api", note: "Z.ai model API (ZCode provider registry)" },
  { match: "*.bigmodel.cn", category: "model-api", note: "Zhipu BigModel API/console incl. open.bigmodel.cn anthropic-compatible endpoint (provider registry)" },
  { match: "api.anthropic.com", category: "model-api", note: "Anthropic API (provider registry; Claude Code default)" },
  { match: "api.openai.com", category: "model-api", note: "OpenAI API (provider registry; Codex default)" },
  { match: "chatgpt.com", category: "model-api", note: "Codex CLI ChatGPT backend (well-known, not in research docs)" },
  { match: "api.deepseek.com", category: "model-api", note: "DeepSeek API (provider registry)" },
  { match: "api.moonshot.cn", category: "model-api", note: "Moonshot/Kimi API (provider registry)" },
  { match: "platform.kimi.com", category: "model-api", note: "Kimi platform endpoint (provider registry)" },
  { match: "api.minimaxi.com", category: "model-api", note: "MiniMax API (provider registry)" },
  { match: "api.x.ai", category: "model-api", note: "xAI Grok API (provider registry)" },
  { match: "platform.xiaomimimo.com", category: "model-api", note: "Xiaomi MiMo endpoint (provider registry)" },
  { match: "*.dashscope.aliyuncs.com", category: "model-api", note: "Alibaba DashScope model API incl. intl host (provider registry)" },
  { match: "modelstudio.console.aliyun.com", category: "model-api", note: "Aliyun Model Studio console/control plane (provider registry)" },
  { match: "bailian.console.aliyun.com", category: "model-api", note: "Aliyun Bailian console/control plane (provider registry)" },
  { match: "openrouter.ai", category: "model-api", note: "OpenRouter aggregator API (provider registry)" },
  { match: "opencode.ai", category: "model-api", note: "opencode-lineage provider: /auth + /zen model endpoints (ZCode CLI bundle is opencode-derived, forensics doc 4.1)" },
  { match: "cloudcode-pa.googleapis.com", category: "model-api", note: "Gemini CLI Code Assist API (well-known, not in research docs)" },
  { match: "generativelanguage.googleapis.com", category: "model-api", note: "Gemini API (well-known, not in research docs)" },

  // ---- telemetry: metrics/APM/RUM channels ----
  { match: /\.log\.aliyuncs\.com$/, category: "telemetry", note: "Aliyun log-service family (all regions): ZCode's ARMS RUM /rum/web/v2 + OTel APM live here — forensics doc observed the hardcoded cn-beijing host; same service family across regions" },
  { match: "statsig.anthropic.com", category: "telemetry", note: "Claude Code metrics/feature-flags (well-known, not in research docs)" },
  { match: "*.sentry.io", category: "telemetry", note: "Sentry crash/error reporting used by several agent tools (well-known, not in research docs)" },
  { match: "collect.alipay.com", category: "telemetry", note: "Alipay analytics/telemetry collector (well-known endpoint, not in research docs)" },

  // ---- update/pki: component downloads and certificate chains ----
  { match: "*.gvt1.com", category: "update", note: "Chrome component/spell-dictionary downloads (forensics doc 4.1, DNS cache observed)" },
  { match: "*.gvt1-cn.com", category: "update", note: "Chrome component CDN, CN edges (forensics doc 4.1)" },
  { match: "*.pki.goog", category: "update", note: "Google PKI/certificate-chain endpoints (forensics doc 4.1)" },
  { match: "*.globalsign.com", category: "update", note: "GlobalSign OCSP/CRL for TLS chains (forensics doc 4.1)" },
  { match: "*.sectigo.com", category: "update", note: "Sectigo OCSP/CRT for TLS chains (forensics doc 4.1)" },

  // ---- captcha: login verification flows ----
  { match: "*.alicdn.com", category: "captcha", note: "Aliyun CDN: FeiLin/Aliyun captcha assets (o./g.alicdn.com, forensics doc 4.1, observed)" },
  { match: "*.captcha-open.aliyuncs.com", category: "captcha", note: "Aliyun captcha API (forensics doc 4.1)" },

  // ---- community: feedback forms/docs, documentary traffic ----
  { match: "*.feishu.cn", category: "community", note: "Feedback forms zhipu-ai.feishu.cn / open.feishu.cn (ZCode config/default.json)" },
  { match: "discord.gg", category: "community", note: "Community link in ZCode config/default.json" },
];

// classify("zcode.z.ai") -> { category: "model-api", note: "..." }
// Unknown/unregistered hosts -> null (callers report category "unknown").
// Normalizes: trim, lowercase, one trailing dot stripped.
export function classify(host: string): ClassifyResult | null {
  const h = host.trim().toLowerCase().replace(/\.+$/, "");
  if (!h) {
    return null;
  }
  for (const rule of DOMAIN_RULES) {
    if (typeof rule.match === "string") {
      if (rule.match.startsWith("*.")) {
        const bare = rule.match.slice(2);
        if (h === bare || h.endsWith(`.${bare}`)) {
          return { category: rule.category, note: rule.note };
        }
      } else if (h === rule.match) {
        return { category: rule.category, note: rule.note };
      }
    } else if (rule.match.test(h)) {
      return { category: rule.category, note: rule.note };
    }
  }
  return null;
}
