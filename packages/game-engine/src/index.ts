export interface LocalJoinUrlInput {
  host: string;
  port: number;
  token: string;
}

export function createLocalJoinUrl(input: LocalJoinUrlInput): string {
  return `http://${input.host}:${input.port}/join/${input.token}`;
}
