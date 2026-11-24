// Images for icons, avatars, banners and emojis: Discord takes them as data URIs.

import { readFile } from "node:fs/promises";

const TYPES: [string, (b: Uint8Array) => boolean][] = [
  ["image/png", (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47],
  ["image/jpeg", (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ["image/gif", (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46],
  ["image/webp", (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50],
];

/** The image type from its first bytes, not its file name. */
export function sniffImage(bytes: Uint8Array): string | null {
  return TYPES.find(([, test]) => test(bytes))?.[0] ?? null;
}

export async function imageDataUri(path: string, options: { maxBytes?: number; allowed?: string[] } = {}): Promise<string> {
  const bytes = new Uint8Array(await readFile(path));
  const type = sniffImage(bytes);
  const allowed = options.allowed ?? ["image/png", "image/jpeg", "image/gif"];
  if (!type || !allowed.includes(type)) {
    throw new Error(`${path} isn't a ${allowed.map((t) => t.replace("image/", "").toUpperCase()).join(", ")} image`);
  }
  if (options.maxBytes && bytes.length > options.maxBytes) {
    throw new Error(`${path} is ${Math.ceil(bytes.length / 1024)} KiB; the limit is ${Math.floor(options.maxBytes / 1024)} KiB`);
  }
  return `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;
}
