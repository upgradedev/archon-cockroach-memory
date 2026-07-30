export interface HostedDastCheck {
  id: string;
  status: "pass" | "fail";
  observedStatus: number | null;
}

export interface HostedDastReceipt {
  schema: "archon.hosted-dast";
  version: 3;
  generatedAt: string;
  profile: "predeploy" | "production-audit" | "exact-release";
  targetOrigin: string;
  releaseSha: string;
  scannerSha: string;
  scannerRunId: number | null;
  scannerRunAttempt: number | null;
  sourceDeployRunId: number | null;
  sourceDeployRunAttempt: number | null;
  passed: boolean;
  checks: HostedDastCheck[];
}

export function runHostedDast(targetUrl: string): Promise<HostedDastReceipt>;
export function writeHostedDastReceipt(
  targetUrl: string,
  receiptPath: string
): Promise<HostedDastReceipt>;
