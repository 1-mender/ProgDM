export class DomainValidationError extends Error {}

export function unicodeLength(value: string): number {
  return Array.from(value).length;
}
