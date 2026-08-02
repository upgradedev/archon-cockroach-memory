export const HOSTED_RECALL_QUESTION: string;
export const HOSTED_RECALL_KIND: "payroll_event";

export interface HostedRecallValidation {
  contractOk: boolean;
  citationsOk: boolean;
  isolated: boolean;
}

export function validateHostedRecallResponse(response: {
  status: unknown;
  body: unknown;
}): HostedRecallValidation;
