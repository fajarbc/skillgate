import { describe, expect, it } from "vitest";
import { sanitizeText } from "./sanitize.js";

describe("trace secret sanitization", () => {
  it("redacts assignment values without reproducing quoted or unquoted credentials", () => {
    const secrets = ["secret123", "hunter2", "access-token", "with spaces"];
    const input =
      'api_key: secret123 password=\'hunter2\' token="access-token" secret = "with spaces"';

    const sanitized = sanitizeText(input);

    expect(sanitized).toBe(
      "api_key: [REDACTED] password=[REDACTED] token=[REDACTED] secret = [REDACTED]",
    );
    for (const secret of secrets) {
      expect(sanitized).not.toContain(secret);
    }
  });

  it("redacts every assignment in a string while preserving unrelated text", () => {
    expect(sanitizeText("mode=preview api-key=first, token=second; status=ok")).toBe(
      "mode=preview api-key=[REDACTED], token=[REDACTED]; status=ok",
    );
  });
});
