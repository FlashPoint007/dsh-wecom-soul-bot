/** Network helpers: the plugin's state route and DSH credential Remotes. */
import {
  STORE_ROUTE, STATE_ROUTE, type BridgeStateView, type StoreOp, type StoreResponse,
} from '../shared/protocol.ts';
import type { CredentialInfo, CredentialsRemote, RemoteEnvelope } from './types.ts';

/** Document-relative, so it follows whatever base path serves the DSH GUI. */
export const STATE_URL = STATE_ROUTE.replace(/^\//, '');
export const STORE_URL = STORE_ROUTE.replace(/^\//, '');

export async function fetchState(refresh: boolean, signal?: AbortSignal): Promise<BridgeStateView> {
  const response = await fetch(`${STATE_URL}${refresh ? '?refresh=1' : ''}`, {
    credentials: 'same-origin', cache: 'no-store', ...(signal ? { signal } : {}),
  });
  if (response.status === 401 || response.status === 403) throw new Error('DSH 登录已失效，请刷新页面。');
  if (response.status === 404) throw new Error('插件后台尚未加载新版本，请重启 DSH 后再试。');
  if (!response.ok) throw new Error(`插件状态读取失败（HTTP ${response.status}）。`);
  return await response.json() as BridgeStateView;
}

/** Apply group/member edits immediately; the Host answers with the fresh table. */
export async function postStore(ops: readonly StoreOp[]): Promise<StoreResponse> {
  let response: Response;
  try {
    response = await fetch(STORE_URL, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ops }),
    });
  } catch {
    throw new Error('无法连接插件后台，请确认 DSH 仍在运行。');
  }
  if (response.status === 401 || response.status === 403) throw new Error('DSH 登录已失效，请刷新页面。');
  if (response.status === 404) throw new Error('插件后台尚未加载新版本，请重启 DSH 后再试。');
  let body: StoreResponse | undefined;
  try {
    body = await response.json() as StoreResponse;
  } catch {
    throw new Error(`修改失败（HTTP ${response.status}）。`);
  }
  if (!body.ok) throw new Error(body.error ?? `修改失败（HTTP ${response.status}）。`);
  return body;
}

function unwrap<T>(result: T | RemoteEnvelope<T>): T | undefined {
  if (result && typeof result === 'object' && 'ok' in result && typeof (result as RemoteEnvelope<T>).ok === 'boolean') {
    const envelope = result as RemoteEnvelope<T>;
    if (!envelope.ok) throw new Error(envelope.error?.message ?? 'DSH 拒绝了请求');
    return envelope.value;
  }
  return result as T;
}

export async function describeCredential(remote: CredentialsRemote | undefined, ref: string): Promise<CredentialInfo | undefined> {
  if (!remote) return undefined;
  return unwrap(await remote.describe([ref]))?.[ref];
}

export async function storeCredential(remote: CredentialsRemote | undefined, ref: string, value: string): Promise<void> {
  if (!remote) throw new Error('DSH 凭据服务未连接。');
  const result = await remote.set(ref, value);
  if (result !== undefined) unwrap(result);
}
