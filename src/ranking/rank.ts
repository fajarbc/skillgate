import type { RankedSkill, RankingInput, ScoreReason } from "./types.js";

const STOP_WORDS = new Set([
  "a", "an", "and", "for", "in", "of", "on", "the", "to", "with",
]);

function terms(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9+#]+/)
      .map((term) => term.replace(/^[.-]+|[.-]+$/g, ""))
      .filter((term) => term.length > 1 && !STOP_WORDS.has(term)),
  );
}

export function rankSkills(input: RankingInput): RankedSkill[] {
  const taskTerms = terms(input.task);
  const projectTerms = new Set(input.signals.map((signal) => signal.name.toLowerCase()));
  const ranked = input.skills.map((skill): RankedSkill => {
    const nameTerms = terms(skill.metadata.name);
    const descriptionTerms = terms(skill.metadata.description);
    const reasons: ScoreReason[] = [];

    for (const term of [...taskTerms].sort()) {
      if (nameTerms.has(term)) reasons.push({ source: "name", term, points: 5 });
      else if (descriptionTerms.has(term)) reasons.push({ source: "description", term, points: 2 });
    }

    for (const term of [...projectTerms].sort()) {
      if (nameTerms.has(term) || descriptionTerms.has(term)) {
        reasons.push({ source: "project", term, points: 3 });
      }
    }

    return {
      ...skill,
      score: reasons.reduce((total, reason) => total + reason.points, 0),
      reasons,
    };
  });

  return ranked
    .filter((skill) => skill.score > 0)
    .sort((a, b) => b.score - a.score || a.metadata.name.localeCompare(b.metadata.name) || a.path.localeCompare(b.path))
    .slice(0, input.limit ?? 8);
}
