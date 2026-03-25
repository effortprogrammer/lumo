declare module "node:fs/promises" {
  export function readdir(path: string): Promise<string[]>;
}
