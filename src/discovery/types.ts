export interface SkillMetadata {
  name: string;
  description: string;
}

export interface DiscoveredSkill {
  path: string;
  metadata?: SkillMetadata;
  error?: string;
}

export interface DiscoveryOptions {
  roots: string[];
  ignoredDirectories?: string[];
}
