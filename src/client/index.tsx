/**
 * Browser half of the WeCom Bot plugin: the plugin homepage.
 *
 * The DSH Web shell loads `dist/client.js`, a CommonJS bundle wrapped in
 * `window.__ModuleLoader__.load({ id, factory })` by scripts/build-client.mjs.
 * `react`, `react/jsx-runtime` and `@deepseek-ai/dsh-client-ui-primitives`
 * stay external: the shell supplies them through the factory's `require`.
 *
 * Module map (src/client):
 *   index.tsx        registration on the `plugins.bundle.config` slot
 *   components/      one file per section (连接, 待授权, 用户分组 + 成员表, 管理员,
 *                    高级设置), ui.tsx building blocks, icons.tsx DSH icons by name
 *   hooks.ts         Config form, credential and state-route bindings
 *   model.ts         pure draft/diff/validation/filter helpers
 *   api.ts           state route and credential Remote helpers
 *   styles.ts        theme-token stylesheet
 */
import { CONFIG_NAMESPACE, PACKAGE_NAME } from '../shared/protocol.ts';
import { SettingsPage } from './components/SettingsPage.tsx';
import { insertStyles } from './styles.ts';
import type { ClientContext, ClientRemote, ConfigForms, SessionNavigation, SlotProps, SlotRegistry } from './types.ts';

export const inject = ['slots', 'configForms', 'remote', 'remote.credentials'];

export function apply(ctx: ClientContext): void {
  const slots = ctx.get('slots') as SlotRegistry | undefined;
  const forms = ctx.get('configForms') as ConfigForms | undefined;
  const remote = ctx.get('remote') as ClientRemote | undefined;
  if (!slots || !forms) return;
  // Resolve at the click, not during apply: the navigation service can be
  // restored independently while the plugin settings page remains mounted.
  const openSession = (sessionId: string): void => {
    const navigation = ctx.get('uiWorkspace') as SessionNavigation | undefined;
    if (!navigation || typeof navigation.openSession !== 'function') {
      throw new Error('DSH 会话导航暂不可用，请刷新页面后重试。');
    }
    navigation.openSession(sessionId);
  };
  ctx.effect(() => insertStyles(), 'wecom-soul-bot: styles');
  // The bundle homepage (not a plugin row) hosts the whole configuration.
  ctx.effect(() => forms.whileServed([CONFIG_NAMESPACE], () => slots.inject('plugins.bundle.config', () => slots.register(
    { name: 'plugins.bundle.config', key: PACKAGE_NAME },
    ({ view }: SlotProps) => (view === 'page' ? <SettingsPage scope={forms.get(CONFIG_NAMESPACE)} remote={remote} onOpenSession={openSession} /> : null),
  ))), 'wecom-soul-bot: plugin homepage');
}
