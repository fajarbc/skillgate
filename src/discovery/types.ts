export type MetadataValue =
  | null
  | boolean
  | number
  | string
  | MetadataValue[]
  | { [key: string]: MetadataValue };

export interface SkillMetadata {
  name: string;
  description: string;
  /** SkillGate policy input, never inferred from host tool permissions. */
  capabilities?: string[];
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  /** Experimental portable field; not a SkillGate policy permission. */
  "allowed-tools"?: string;
  /** Untrusted fields, never merged into routing or policy inputs. */
  extensions?: Record<string, MetadataValue>;
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
