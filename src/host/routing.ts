import { DEFAULT_GROUP_ID, type BindingRecord, type GroupRecord } from '../shared/protocol.js';
import { bindingKey, bindingKeyFor, type BindingKeyParts, type PluginStore } from './store.js';
import { SessionBindingChangedError, type SessionProvisioner } from './sessions.js';
import { routingChangedText } from './bridge/notices.js';

/**
 * Routing: which Session one WeCom conversation talks to.
 *
 * Every authorized private chat owns the Session bound to its sender, every
 * authorized group owns the Session bound to the group — members can never
 * reach another conversation's Session. Membership is durable, so routing
 * survives a Host restart instead of depending on who happened to message the
 * Bot since it started. The group a member belongs to decides the Workspace
 * and the model; the member row decides the Session.
 */

export interface RouteResult {
  readonly ok: boolean;
  readonly binding?: BindingRecord;
  readonly group?: GroupRecord;
  readonly sessionId?: string;
  /** True when this call created the Session. */
  readonly created?: boolean;
  /** Operator-facing explanation of a failed route. */
  readonly message?: string;
}

export interface Router {
  /** The member row for a conversation, authorized into `groupId` when new. */
  ensure(parts: BindingKeyParts, groupId: string): Promise<BindingRecord>;
  /** The Session a plain message from this conversation must be submitted to. */
  route(parts: BindingKeyParts, groupId: string): Promise<RouteResult>;
  /** Every member currently pointing at one Session. */
  forSession(sessionId: string): readonly BindingRecord[];
  /** Re-install the group's model on every Session of that group. */
  reapplyGroup(groupId: string): Promise<void>;
  /**
   * Put every Session of that group under the group's Workspace access.
   * Resolves to the members whose Session could not be updated, with the reason.
   */
  reapplyPermission(groupId: string): Promise<readonly { readonly key: string; readonly message: string }[]>;
  /** The group that decides Workspace and model for one member. */
  groupOf(binding: BindingRecord): GroupRecord;
  readonly store: PluginStore;
  readonly provisioner: SessionProvisioner;
}

export interface RouterOptions {
  readonly store: PluginStore;
  readonly provisioner: SessionProvisioner;
  readonly log?: { warn(message: string): void };
}

export function routerKey(binding: BindingRecord): string {
  return bindingKey(binding.kind, binding.id);
}

export function createRouter(options: RouterOptions): Router {
  const { store, provisioner } = options;

  function groupOf(binding: BindingRecord): GroupRecord {
    return store.group(binding.groupId) ?? store.group(DEFAULT_GROUP_ID)!;
  }

  async function ensure(parts: BindingKeyParts, groupId: string): Promise<BindingRecord> {
    const existing = store.get(bindingKeyFor(parts));
    if (existing) return existing;
    return await store.create(
      parts.chatType === 'group' ? 'group' : 'user',
      parts.chatType === 'group' ? parts.chat : parts.user,
      { groupId },
    );
  }

  return {
    store,
    provisioner,
    ensure,
    groupOf,
    async route(parts, _groupId) {
      // Only an explicit authorization creates memberships. A principal removed
      // after the bridge's access check must not be silently re-authorized here.
      const binding = store.get(bindingKeyFor(parts));
      if (!binding) return { ok: false, message: routingChangedText() };
      const group = groupOf(binding);
      try {
        const provisioned = await provisioner.ensure(binding, group);
        const current = store.get(routerKey(binding));
        // Provisioning can yield after its final check; never turn a removed
        // binding back into a successful route by falling back to its old row.
        if (!current || current !== provisioned.binding || current.groupId !== group.id
          || current.sessionId !== provisioned.sessionId || store.group(group.id) !== group) {
          throw new SessionBindingChangedError();
        }
        return {
          ok: true, binding: current, group,
          sessionId: provisioned.sessionId, created: provisioned.created,
        };
      } catch (error) {
        if (error instanceof SessionBindingChangedError) {
          const current = store.get(routerKey(binding));
          return {
            ok: false,
            ...(current ? { binding: current, group: groupOf(current) } : {}),
            message: routingChangedText(),
          };
        }
        options.log?.warn(`WeCom could not create a Session: ${error instanceof Error ? error.message : String(error)}`);
        return {
          ok: false, binding, group,
          // The Workspace, the preset and the model all take part in creating a
          // Session, so name the group rather than guessing which one failed.
          message: `无法在分组「${group.name}」中创建会话：${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
    forSession: sessionId => store.forSession(sessionId),
    async reapplyPermission(groupId) {
      const group = store.group(groupId);
      if (!group) return [];
      const failures: { key: string; message: string }[] = [];
      for (const binding of store.inGroup(groupId)) {
        if (!binding.sessionId) continue;
        // A Session that is gone or archived has nothing to restrict; the next
        // one is created under the group's mode.
        const described = await provisioner.describe(binding.sessionId);
        if (described.state !== 'bound' && described.state !== 'blank') continue;
        try {
          await provisioner.applyPermission(binding.sessionId, group.permission);
        } catch (error) {
          failures.push({ key: routerKey(binding), message: error instanceof Error ? error.message : String(error) });
        }
      }
      return failures;
    },
    async reapplyGroup(groupId) {
      const group = store.group(groupId);
      if (!group) return;
      const selection = provisioner.desired(group);
      if (!selection) return;
      for (const binding of store.inGroup(groupId)) {
        if (!binding.sessionId || binding.sessionSelection) continue;
        try {
          await provisioner.applyModel(binding.sessionId, selection);
        } catch (error) {
          options.log?.warn(`WeCom could not apply the group model: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    },
  };
}
