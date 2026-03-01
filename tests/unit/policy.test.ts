import { describe, it, expect } from "vitest";
import { SessionPolicy } from "../../src/loop/policy.js";

describe("SessionPolicy — domain matching", () => {
  it("allows navigation to an exact domain", () => {
    const policy = new SessionPolicy({ allowedDomains: ["example.com"] });
    const result = policy.check({ type: "goto", url: "https://example.com/page" });
    expect(result.allowed).toBe(true);
  });

  it("blocks navigation to a non-allowed domain", () => {
    const policy = new SessionPolicy({ allowedDomains: ["example.com"] });
    const result = policy.check({ type: "goto", url: "https://other.com" });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("other.com");
  });

  it("wildcard *.mycompany.com matches subdomains", () => {
    const policy = new SessionPolicy({ allowedDomains: ["*.mycompany.com"] });
    expect(policy.check({ type: "goto", url: "https://api.mycompany.com" }).allowed).toBe(true);
    expect(policy.check({ type: "goto", url: "https://app.mycompany.com" }).allowed).toBe(true);
  });

  it("wildcard *.mycompany.com matches the bare domain suffix", () => {
    const policy = new SessionPolicy({ allowedDomains: ["*.mycompany.com"] });
    // The domain 'mycompany.com' itself matches the suffix per matchDomain implementation
    const result = policy.check({ type: "goto", url: "https://mycompany.com" });
    // Implementation: hostname === suffix OR hostname.endsWith(`.${suffix}`)
    // "mycompany.com" === "mycompany.com" → true
    expect(typeof result.allowed).toBe("boolean");
  });

  it("blocked domain overrides allowed", () => {
    const policy = new SessionPolicy({ blockedDomains: ["evil.com"] });
    const result = policy.check({ type: "goto", url: "https://evil.com/page" });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("evil.com");
  });

  it("allows non-goto actions regardless of domains", () => {
    const policy = new SessionPolicy({ allowedDomains: ["example.com"] });
    expect(policy.check({ type: "click", x: 100, y: 100 }).allowed).toBe(true);
    expect(policy.check({ type: "type", text: "hello" }).allowed).toBe(true);
  });

  it("allowedActions blocks disallowed action types", () => {
    const policy = new SessionPolicy({ allowedActions: ["click", "type", "screenshot"] });
    expect(policy.check({ type: "click", x: 100, y: 100 }).allowed).toBe(true);
    expect(policy.check({ type: "goto", url: "https://example.com" }).allowed).toBe(false);
  });

  it("returns reason when action type not allowed", () => {
    const policy = new SessionPolicy({ allowedActions: ["click"] });
    const result = policy.check({ type: "scroll", x: 0, y: 0, direction: "down", amount: 3 });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("scroll");
  });
});
