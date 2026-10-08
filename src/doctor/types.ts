export type DiagnosticStatus = "ok" | "warn" | "fail";

export interface DiagnosticCheck {
  name: string;
  status: DiagnosticStatus;
  message: string;
  detail?: Record<string, unknown> | string;
}

export interface DoctorReport {
  timestamp: string;
  status: DiagnosticStatus;
  version: string;
  nodeVersion: string;
  root: string;
  checks: DiagnosticCheck[];
  summary: {
    total: number;
    passed: number;
    warnings: number;
    failures: number;
  };
}
