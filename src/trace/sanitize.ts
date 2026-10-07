const SECRET_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /bearer\s+[A-Za-z0-9._~+/-]+=*/gi, replacement: "Bearer [REDACTED]" },
  { pattern: /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, replacement: "[REDACTED_GH_TOKEN]" },
  { pattern: /sk-[a-zA-Z0-9_-]{10,}/g, replacement: "[REDACTED_API_KEY]" },
  { pattern: /AKIA[0-9A-Z]{16}/g, replacement: "[REDACTED_AWS_KEY]" },
  { pattern: /-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+ PRIVATE KEY-----/g, replacement: "[REDACTED_PRIVATE_KEY]" },
  { pattern: /(?:api[_-]?key|secret|password|passwd|token)\s*[:=]\s*['"]?([^\s'"&,]+)/gi, replacement: "$1=[REDACTED]" },
];

export function sanitizeText(text: string): string {
  let result = text;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}
