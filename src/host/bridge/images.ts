/**
 * Image input: a WeCom image (or the images of a mixed message) is downloaded
 * with the SDK's downloadFile (it decrypts with the per-message aeskey) and
 * handed to DSH as image content blocks, the shape dsh-im uses:
 * { type: 'image', mediaType, data: base64 }.
 *
 * Images are only fetched for authorized senders, capped in count and size, and
 * a failed download degrades to a text note instead of dropping the message.
 */

export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export interface ImageRef { readonly url: string; readonly aeskey?: string }

export type PromptBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly mediaType: string; readonly data: string; readonly name?: string };

/** Image URLs and the text parts of an image or mixed callback body. */
export function imagePartsOf(body: unknown): { readonly images: ImageRef[]; readonly text: string } {
  const b = body as { msgtype?: unknown; image?: { url?: unknown; aeskey?: unknown }; mixed?: { msg_item?: unknown } } | undefined;
  const images: ImageRef[] = [];
  const texts: string[] = [];
  const push = (img: { url?: unknown; aeskey?: unknown } | undefined) => {
    if (img && typeof img.url === 'string' && /^https:\/\//.test(img.url)) {
      images.push({ url: img.url, ...(typeof img.aeskey === 'string' ? { aeskey: img.aeskey } : {}) });
    }
  };
  if (b?.msgtype === 'image') push(b.image);
  if (b?.msgtype === 'mixed' && Array.isArray(b.mixed?.msg_item)) {
    for (const raw of b.mixed!.msg_item as unknown[]) {
      const item = raw as { msgtype?: unknown; text?: { content?: unknown }; image?: { url?: unknown; aeskey?: unknown } } | null;
      if (item?.msgtype === 'image') push(item.image);
      else if (item?.msgtype === 'text' && typeof item.text?.content === 'string') texts.push(item.text.content);
    }
  }
  return { images: images.slice(0, MAX_IMAGES), text: texts.join('\n').trim() };
}

/** Sniff the media type from magic bytes; WeCom does not say. */
export function sniffImage(buffer: Uint8Array): string | undefined {
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return 'image/gif';
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46
    && buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) return 'image/webp';
  return undefined;
}

export type Downloader = (url: string, aesKey?: string) => Promise<{ buffer: Buffer }>;

/** Download and encode every image; returns the blocks and how many could not be used. */
export async function loadImages(images: readonly ImageRef[], download: Downloader): Promise<{ blocks: PromptBlock[]; failed: number }> {
  const blocks: PromptBlock[] = [];
  let failed = 0;
  for (const [index, image] of images.entries()) {
    try {
      const { buffer } = await download(image.url, image.aeskey);
      const mediaType = sniffImage(buffer);
      if (!mediaType || buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) { failed++; continue; }
      blocks.push({ type: 'image', mediaType, data: buffer.toString('base64'), name: 'wecom-image-' + (index + 1) });
    } catch {
      failed++;
    }
  }
  return { blocks, failed };
}
