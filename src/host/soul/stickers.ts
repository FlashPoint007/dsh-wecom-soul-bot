import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BindingRecord } from '../../shared/protocol.js';
import type { Journal } from '../journal.js';

/**
 * Sticker library: images the owner sends can be saved under a name, and the
 * persona can send them back into a conversation as WeCom image messages.
 *
 * WeCom does not forward its own stickers (emotion messages) to smart bots, so
 * the library is fed from ordinary image messages: the bridge keeps the last
 * images of each chat for a short while, and wecom_sticker_save stores them.
 */

export const MAX_STICKERS = 200;
export const MAX_STICKER_BYTES = 2 * 1024 * 1024;
export const RECENT_IMAGE_TTL_MS = 30 * 60 * 1000;

export interface Sticker {
  readonly id: string;
  readonly name: string;
  readonly tags: readonly string[];
  readonly mediaType: string;
  readonly file: string;
  readonly bytes: number;
  readonly addedBy: string;
  readonly addedAt: number;
}

export interface ImageBytes {
  readonly buffer: Buffer;
  readonly mediaType: string;
}

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

export function cleanName(value: unknown): string {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 30);
}

export interface StickerStore {
  load(): Promise<void>;
  list(): readonly Sticker[];
  find(query: string): Sticker | undefined;
  add(image: ImageBytes, name: string, tags: readonly string[], addedBy: string): Promise<Sticker>;
  remove(name: string): Promise<boolean>;
  read(sticker: Sticker): Promise<Buffer>;
}

export function createStickerStore(options: { readonly directory: string; readonly now?: () => number }): StickerStore {
  const dir = options.directory;
  const indexFile = join(dir, 'index.json');
  const now = options.now ?? Date.now;
  let items: Sticker[] = [];
  let loaded: Promise<void> | undefined;
  let writes: Promise<unknown> = Promise.resolve();
  const serialized = <T>(task: () => Promise<T>): Promise<T> => {
    const run = writes.then(task, task);
    writes = run.catch(() => {});
    return run;
  };
  const persist = async () => {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temp = indexFile + '.' + process.pid + '.tmp';
    await writeFile(temp, JSON.stringify({ version: 1, stickers: items }, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    await rename(temp, indexFile);
    await chmod(indexFile, 0o600).catch(() => {});
  };
  return {
    load() {
      loaded ??= (async () => {
        try {
          const parsed = JSON.parse(await readFile(indexFile, 'utf8')) as { stickers?: unknown };
          items = (Array.isArray(parsed.stickers) ? parsed.stickers : []).filter((s): s is Sticker => {
            const r = s as Partial<Sticker> | null;
            return Boolean(r) && typeof r!.id === 'string' && typeof r!.name === 'string' && typeof r!.file === 'string'
              && /^[A-Za-z0-9-]+\.(png|jpg|gif|webp)$/.test(r!.file) && typeof r!.mediaType === 'string';
          }).map(s => ({ ...s, tags: Array.isArray(s.tags) ? s.tags.filter(t => typeof t === 'string') : [] }));
        } catch {
          items = [];
        }
      })();
      return loaded;
    },
    list: () => items,
    find(query) {
      const q = cleanName(query).toLowerCase();
      if (!q) return undefined;
      return items.find(s => s.name.toLowerCase() === q)
        ?? items.find(s => s.name.toLowerCase().includes(q) || s.tags.some(t => t.toLowerCase() === q));
    },
    add(image, name, tags, addedBy) {
      return serialized(async () => {
        const clean = cleanName(name);
        if (!clean) throw new Error('表情包需要一个名字。');
        const ext = EXT[image.mediaType];
        if (!ext) throw new Error('只支持 PNG、JPEG、GIF、WebP 图片。');
        if (image.buffer.length > MAX_STICKER_BYTES) throw new Error('图片超过 2 MiB，不能存成表情包。');
        const existing = items.find(s => s.name.toLowerCase() === clean.toLowerCase());
        if (!existing && items.length >= MAX_STICKERS) throw new Error('表情包已经存满 ' + MAX_STICKERS + ' 张，先删掉一些。');
        const id = randomUUID();
        const file = id + '.' + ext;
        await mkdir(dir, { recursive: true, mode: 0o700 });
        await writeFile(join(dir, file), image.buffer, { mode: 0o600 });
        const sticker: Sticker = {
          id, name: clean, tags: tags.map(cleanName).filter(Boolean).slice(0, 8), mediaType: image.mediaType,
          file, bytes: image.buffer.length, addedBy, addedAt: now(),
        };
        if (existing) await unlink(join(dir, existing.file)).catch(() => {});
        items = [...items.filter(s => s !== existing), sticker];
        await persist();
        return sticker;
      });
    },
    remove(name) {
      return serialized(async () => {
        const clean = cleanName(name).toLowerCase();
        const target = items.find(s => s.name.toLowerCase() === clean);
        if (!target) return false;
        items = items.filter(s => s !== target);
        await persist();
        await unlink(join(dir, target.file)).catch(() => {});
        return true;
      });
    },
    read: sticker => readFile(join(dir, sticker.file)),
  };
}

export interface StickerToolContext {
  readonly stickers: StickerStore;
  readonly journal: Pick<Journal, 'write'>;
  bindingFor(sessionId: string | undefined): BindingRecord | undefined;
  senderOf(sessionId: string): { readonly user: string } | undefined;
  isOwner(user: string): boolean;
  /** The images the chat sent within the last half hour, newest last. */
  recentImages(chat: string): readonly ImageBytes[];
  /** Upload and send one image to a chat; resolves false when the connection cannot send. */
  sendImage(chat: string, image: ImageBytes, filename: string): Promise<boolean>;
}

type Exec = { agent?: { id?: string; session?: { id?: string } } } | undefined;

/** wecom_sticker_save / wecom_sticker_send / wecom_sticker_list / wecom_sticker_delete. */
export function buildStickerTools(define: (options: unknown) => unknown, tc: StickerToolContext): unknown[] {
  const target = (exec: Exec) => {
    const sessionId = exec?.agent?.session?.id ?? exec?.agent?.id;
    const binding = tc.bindingFor(sessionId);
    if (!sessionId || !binding) throw new Error('这个工具只在企业微信机器人的会话里可用。');
    return { sessionId, chat: binding.id };
  };
  const requireOwner = (sessionId: string) => {
    const sender = tc.senderOf(sessionId);
    if (!sender || !tc.isOwner(sender.user)) throw new Error('只有主人能往表情包库里存或删表情包。');
    return sender.user;
  };
  const save = define({
    name: 'wecom_sticker_save',
    description: '企业微信机器人专用：把这个会话最近 30 分钟内收到的图片存进表情包库（默认存最新一张；index 从 1 开始，1 是最新的）。只有主人能存。企业微信自带的表情不会转发给机器人，所以表情包要用普通图片发过来。',
    parameters: {
      name: { type: 'string', required: true, description: '表情包的名字，最多 30 字，例如「不干了」「得意」。同名会覆盖。' },
      tags: { type: 'array', items: { type: 'string' }, description: '可选的情绪或场景标签，例如 ["委屈","摆烂"]。' },
      index: { type: 'integer', description: '存倒数第几张图，1 = 最新（默认）。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { name: { type: 'string' }, total: { type: 'integer' } } },
      render: (_a: unknown, v: { name: string; total: number }) => [{ type: 'text', text: '已存表情包「' + v.name + '」，库里现在有 ' + v.total + ' 张。' }],
    },
    isConcurrencySafe: () => false,
    async execute(args: { name?: unknown; tags?: unknown; index?: unknown }, exec: Exec) {
      const { sessionId, chat } = target(exec);
      const by = requireOwner(sessionId);
      const images = tc.recentImages(chat);
      if (!images.length) throw new Error('最近 30 分钟这个会话没有收到图片；先把要存的图片发过来。');
      const index = typeof args.index === 'number' && args.index >= 1 ? Math.floor(args.index) : 1;
      const image = images[images.length - index];
      if (!image) throw new Error('没有第 ' + index + ' 张图，最近只有 ' + images.length + ' 张。');
      const tags = Array.isArray(args.tags) ? args.tags.map(String) : [];
      const sticker = await tc.stickers.add(image, String(args.name ?? ''), tags, by);
      tc.journal.write({ event: 'soul.sticker.save', sessionId, name: sticker.name, bytes: sticker.bytes });
      return { name: sticker.name, total: tc.stickers.list().length };
    },
    presentCall: (args: unknown) => ({ card: 'generic', title: '存表情包', kind: 'other', rawInput: args }),
  });
  const send = define({
    name: 'wecom_sticker_send',
    description: '企业微信机器人专用：从表情包库里挑一张发到当前私聊或群里（按名字或标签找）。开玩笑、得意、嫌弃、委屈、被夸的时候适合发，大约三四次回复配一张，别每句都发。图片会在你的文字回复之前送达。',
    parameters: { name: { type: 'string', required: true, description: '表情包名字或标签。' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { sent: { type: 'boolean' }, name: { type: 'string' } } },
      render: (_a: unknown, v: { sent: boolean; name: string }) => [{ type: 'text', text: v.sent ? '已发出表情包「' + v.name + '」。' : '表情包「' + v.name + '」没发出去（连接不可用）。' }],
    },
    isConcurrencySafe: () => false,
    async execute(args: { name?: unknown }, exec: Exec) {
      const { sessionId, chat } = target(exec);
      const sticker = tc.stickers.find(String(args.name ?? ''));
      if (!sticker) throw new Error('库里没有叫「' + cleanName(args.name) + '」的表情包；用 wecom_sticker_list 看看有哪些。');
      const buffer = await tc.stickers.read(sticker);
      const sent = await tc.sendImage(chat, { buffer, mediaType: sticker.mediaType }, sticker.file);
      tc.journal.write({ event: 'soul.sticker.send', sessionId, name: sticker.name, sent });
      return { sent, name: sticker.name };
    },
    presentCall: (args: unknown) => ({ card: 'generic', title: '发表情包', kind: 'other', rawInput: args }),
  });
  const list = define({
    name: 'wecom_sticker_list',
    description: '企业微信机器人专用：列出表情包库里的表情包名字和标签。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { stickers: { type: 'array', items: { type: 'string' } } } },
      render: (_a: unknown, v: { stickers: string[] }) => [{ type: 'text', text: v.stickers.length ? v.stickers.join('\n') : '表情包库是空的。' }],
    },
    isConcurrencySafe: () => true,
    async execute(_args: unknown, exec: Exec) {
      target(exec);
      return { stickers: tc.stickers.list().map(s => s.name + (s.tags.length ? '（' + s.tags.join('、') + '）' : '')) };
    },
  });
  const remove = define({
    name: 'wecom_sticker_delete',
    description: '企业微信机器人专用：从表情包库里删掉一张（按完整名字）。只有主人能删。',
    parameters: { name: { type: 'string', required: true, description: '要删的表情包名字。' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { removed: { type: 'boolean' } } },
      render: (_a: unknown, v: { removed: boolean }) => [{ type: 'text', text: v.removed ? '已删除。' : '没找到这个表情包。' }],
    },
    isConcurrencySafe: () => false,
    async execute(args: { name?: unknown }, exec: Exec) {
      const { sessionId } = target(exec);
      requireOwner(sessionId);
      const removed = await tc.stickers.remove(String(args.name ?? ''));
      tc.journal.write({ event: 'soul.sticker.delete', sessionId, removed });
      return { removed };
    },
  });
  return [save, send, list, remove];
}
