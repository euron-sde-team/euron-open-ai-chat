export interface StubRequest {
  method: string;
  path: string;
  at: string;
  body: unknown;
  headers: { authorization: "present" | "absent" };
}
export interface Stubs {
  handler(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): Promise<void>;
  config: { publicUrl: string };
  state: { requests: StubRequest[] };
}
export function createStubs(options?: { port?: number; publicUrl?: string }): Stubs;
export function startStubs(options?: { port?: number; host?: string; publicUrl?: string }): Promise<Stubs & { url: string; close(): Promise<void> }>;
export function gradientPng(width: number, height: number, seedText: string): Buffer;
export function parseMultipart(buf: Buffer, contentType: string): Record<string, string | { filename: string; type?: string; data: Buffer }>;
