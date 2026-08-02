import type { Server } from "node:http";

export interface PredeployZapServerOptions {
  webRoot: string;
}

export function createPredeployZapServer(
  options?: PredeployZapServerOptions
): Promise<Server>;

export function parsePredeployZapPort(value: string | undefined): number;
