export interface ProjectSignal {
  kind: "language" | "runtime" | "framework" | "tool";
  name: string;
  evidence: string;
}

export interface DetectionOptions {
  root: string;
}
