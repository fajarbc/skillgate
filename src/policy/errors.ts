export class PolicyError extends Error {
  constructor(message: string, public readonly filePath?: string) {
    super(filePath ? `${message} in ${filePath}` : message);
    this.name = "PolicyError";
  }
}
