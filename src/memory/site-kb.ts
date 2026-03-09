import { readFileSync, writeFileSync } from "fs";

export interface SiteRule {
  /** Domain pattern: "google.com/travel", "allrecipes.com", "*.booking.com" */
  domain: string;
  /** Rules injected into system prompt when URL matches */
  rules: string[];
}

/**
 * Site-specific knowledge base.
 * Maps domain patterns to rules injected into the agent's system prompt.
 * Grows from eval successes — knowledge compounds over time.
 */
export class SiteKB {
  private rules: SiteRule[];

  constructor(rules?: SiteRule[]) {
    this.rules = rules ?? [];
  }

  static fromFile(path: string): SiteKB {
    try {
      const data = JSON.parse(readFileSync(path, "utf-8")) as SiteRule[];
      return new SiteKB(data);
    } catch {
      return new SiteKB();
    }
  }

  /**
   * Return all rules matching the given URL.
   */
  match(url: string): string[] {
    let hostname: string;
    let pathname: string;
    try {
      const u = new URL(url);
      hostname = u.hostname;
      pathname = u.pathname;
    } catch {
      return [];
    }

    const matched: string[] = [];
    for (const rule of this.rules) {
      if (domainMatches(rule.domain, hostname, pathname)) {
        matched.push(...rule.rules);
      }
    }
    return matched;
  }

  addRule(domain: string, rule: string): void {
    const existing = this.rules.find((r) => r.domain === domain);
    if (existing) {
      if (!existing.rules.includes(rule)) {
        existing.rules.push(rule);
      }
    } else {
      this.rules.push({ domain, rules: [rule] });
    }
  }

  toJSON(): SiteRule[] {
    return this.rules;
  }

  save(path: string): void {
    writeFileSync(path, JSON.stringify(this.rules, null, 2), "utf-8");
  }

  /**
   * Format matched rules for system prompt injection.
   */
  formatForPrompt(url: string): string | undefined {
    const rules = this.match(url);
    if (rules.length === 0) return undefined;
    return "SITE-SPECIFIC TIPS:\n" + rules.map((r) => `- ${r}`).join("\n");
  }
}

/** Check if a domain pattern matches the given hostname + pathname */
function domainMatches(pattern: string, hostname: string, pathname: string): boolean {
  const fullPath = hostname + pathname;

  // Wildcard prefix: "*.booking.com" matches "www.booking.com"
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(2);
    return hostname.endsWith(suffix) || fullPath.includes(suffix);
  }

  // Contains check: "google.com/travel" matches "www.google.com/travel/flights"
  return fullPath.includes(pattern);
}
