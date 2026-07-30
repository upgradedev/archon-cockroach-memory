export interface HostedDastCheck {
  id: string;
  status: "pass";
  observedStatus: number;
}

export interface HostedDastReceipt {
  schema: "archon.hosted-dast";
  version: 2;
  generatedAt: string;
  targetOrigin: string;
  releaseSha: string;
  scannerSha: string;
  passed: boolean;
  checks: HostedDastCheck[];
}

export function runHostedDast(targetUrl: string): Promise<HostedDastReceipt>;
