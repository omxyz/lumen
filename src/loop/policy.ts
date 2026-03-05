import type { Action } from "../types.js";

export interface SessionPolicyResult {
  allowed: boolean;
  /** Present when allowed === false. Fed back as is_error tool result. */
  reason?: string;
}

export interface SessionPolicyOptions {
  /** Glob-style domain patterns. e.g. ["*.mycompany.com", "api.stripe.com"] */
  allowedDomains?: string[];
  blockedDomains?: string[];
  /** Restrict which action types the model may emit. */
  allowedActions?: Action["type"][];
}

/** Allowlist filter checked before every model-emitted action.
 *  NOT OS-level isolation — page-initiated redirects bypass this.
 *  For hard network restrictions use infrastructure-level isolation. */
export class SessionPolicy {
  constructor(private readonly options: SessionPolicyOptions) {}

  check(action: Action): SessionPolicyResult {
    // Action type filter
    if (
      this.options.allowedActions &&
      !this.options.allowedActions.includes(action.type)
    ) {
      return { allowed: false, reason: `action type "${action.type}" is not permitted by session policy` };
    }

    // Domain filter for goto
    if (action.type === "goto") {
      const result = this.checkDomain(action.url);
      if (!result.allowed) return result;
    }

    return { allowed: true };
  }

  private checkDomain(url: string): SessionPolicyResult {
    let hostname: string;
    try {
      hostname = new URL(url).hostname;
    } catch {
      return { allowed: false, reason: `invalid URL: ${url}` };
    }

    if (this.options.blockedDomains?.some((pattern) => matchDomain(hostname, pattern))) {
      return { allowed: false, reason: `navigation to "${hostname}" is blocked by session policy` };
    }

    if (
      this.options.allowedDomains &&
      !this.options.allowedDomains.some((pattern) => matchDomain(hostname, pattern))
    ) {
      return {
        allowed: false,
        reason: `navigation to "${hostname}" is outside allowed domains — session policy only permits: ${this.options.allowedDomains.join(", ")}`,
      };
    }

    return { allowed: true };
  }
}

function matchDomain(hostname: string, pattern: string): boolean {
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(2);
    return hostname === suffix || hostname.endsWith(`.${suffix}`);
  }
  return hostname === pattern;
}
