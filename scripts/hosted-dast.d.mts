export interface HostedDastCheck {
  id: string;
  status: "pass";
  observedStatus: number;
}

export interface HostedDastReceipt {
  schema: "archon.hosted-dast";
  version: 1;
  generatedAt: string;
  targetOrigin: string;
  releaseSha: string;
  passed: boolean;
  checks: HostedDastCheck[];
}

export function runHostedDast(targetUrl: string): Promise<HostedDastReceipt>;
