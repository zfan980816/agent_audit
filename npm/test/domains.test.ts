// M5: domain registry unit tests. The registry is ground truth from
// docs/superpowers/research/2026-09-20-zcode-forensics.md section 4 (domain
// inventory) plus a few well-known agent endpoints marked with notes.
import { expect, test } from "vitest";

import {
  CATEGORY_ORDER,
  DOMAIN_RULES,
  classify,
} from "../src/domains.js";

test("model-api hosts classify as model-api", () => {
  const hosts = [
    "zcode.z.ai", // ZCode main backend (configs/billing/model plan)
    "api.z.ai",
    "open.bigmodel.cn",
    "bigmodel.cn",
    "api.anthropic.com",
    "api.openai.com",
    "chatgpt.com",
    "api.deepseek.com",
    "api.moonshot.cn",
    "platform.kimi.com",
    "api.minimaxi.com",
    "api.x.ai",
    "platform.xiaomimimo.com",
    "dashscope.aliyuncs.com",
    "intl.dashscope.aliyuncs.com",
    "modelstudio.console.aliyun.com",
    "bailian.console.aliyun.com",
    "openrouter.ai",
    "opencode.ai",
    "cloudcode-pa.googleapis.com",
    "generativelanguage.googleapis.com",
  ];
  for (const host of hosts) {
    expect(classify(host)?.category, host).toBe("model-api");
  }
});

test("aliyun log endpoints (ZCode ARMS RUM/APM) classify as telemetry", () => {
  const host =
    "proj-xtrace-7e235817c9b9381c22d8b743908d469f-cn-beijing.cn-beijing.log.aliyuncs.com";
  const hit = classify(host);
  expect(hit?.category).toBe("telemetry");
  expect(classify("anything.cn-beijing.log.aliyuncs.com")?.category).toBe(
    "telemetry",
  );
  // bare TLD node has NO rule: aliyuncs ranges are too broad to classify (design)
  expect(classify("aliyuncs.com")).toBeNull();
});

test("other telemetry endpoints classify as telemetry", () => {
  expect(classify("statsig.anthropic.com")?.category).toBe("telemetry");
  expect(classify("o1234.sentry.io")?.category).toBe("telemetry");
  expect(classify("collect.alipay.com")?.category).toBe("telemetry");
});

test("update/pki endpoints classify as update", () => {
  const hosts = [
    "redirector.gvt1.com",
    "r3---sn-2x3eenes.gvt1-cn.com",
    "pki.goog",
    "sub.pki.goog",
    "secure.globalsign.com",
    "ocsp.globalsign.com",
    "crl.globalsign.com",
    "sectigo.com",
    "crt.sectigo.com",
  ];
  for (const host of hosts) {
    expect(classify(host)?.category, host).toBe("update");
  }
});

test("captcha endpoints classify as captcha", () => {
  const hosts = [
    "o.alicdn.com",
    "g.alicdn.com",
    "static.alicdn.com",
    "captcha-open.aliyuncs.com",
    "feilin.captcha-open.aliyuncs.com",
  ];
  for (const host of hosts) {
    expect(classify(host)?.category, host).toBe("captcha");
  }
});

test("feedback/community endpoints classify as community", () => {
  expect(classify("zhipu-ai.feishu.cn")?.category).toBe("community");
  expect(classify("open.feishu.cn")?.category).toBe("community");
  expect(classify("discord.gg")?.category).toBe("community");
});

test("unknown domains return null (caller reports them as unknown)", () => {
  expect(classify("example.com")).toBeNull();
  expect(classify("evil-paste-site.net")).toBeNull();
  expect(classify("localhost")).toBeNull();
  expect(classify("")).toBeNull();
  expect(classify("   ")).toBeNull();
});

test("classify normalizes case and one trailing dot", () => {
  expect(classify("ZCODE.Z.AI")?.category).toBe("model-api");
  expect(classify("Zcode.Z.Ai.")?.category).toBe("model-api");
  expect(classify("EXAMPLE.COM")).toBeNull();
});

test("every rule carries a known category and a non-empty note", () => {
  expect(DOMAIN_RULES.length).toBeGreaterThan(10);
  for (const rule of DOMAIN_RULES) {
    expect(CATEGORY_ORDER, rule.category as never).toContain(rule.category);
    expect(rule.note, JSON.stringify(rule.match)).toBeTruthy();
  }
});

test("string rules are lowercase and unique", () => {
  const seen = new Set<string>();
  for (const rule of DOMAIN_RULES) {
    if (typeof rule.match === "string") {
      expect(rule.match, rule.match).toBe(rule.match.toLowerCase());
      expect(seen.has(rule.match), rule.match).toBe(false);
      seen.add(rule.match);
    }
  }
});

test("at least one RegExp rule exists and matches the aliyun log pattern", () => {
  const regexRules = DOMAIN_RULES.filter((r) => r.match instanceof RegExp);
  expect(regexRules.length).toBeGreaterThan(0);
  expect(
    regexRules.some((r) => (r.match as RegExp).test("x.cn-beijing.log.aliyuncs.com")),
  ).toBe(true);
});

test("category order puts unknown last (summary line ordering)", () => {
  expect(CATEGORY_ORDER[CATEGORY_ORDER.length - 1]).toBe("unknown");
  expect(CATEGORY_ORDER[0]).toBe("model-api");
});
