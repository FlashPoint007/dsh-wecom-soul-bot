import type { RejectionReason } from '../../shared/protocol.js';
import { pathListed, type BridgeSettings } from '../config.js';
import type { BindingKeyParts } from '../store.js';

/**
 * Access policy: who may talk to the Bot at all.
 *
 * There is exactly one answer — membership of a user group, which is what the
 * settings page grants when it assigns a rejected sender to a group.
 * Administrators are the one exception in private chats: the store's settings
 * grant access to commands without creating membership. Plain messages still
 * need an explicit group or a Session chosen with `/new` or `/use`. An admin
 * sending from an unassigned group chat never authorizes that shared chat.
 *
 * Routing is not decided here: which Session a conversation reaches comes from
 * its member row, and only administrators may leave their own membership.
 */
export interface AccessPolicy {
  readonly adminUserIds: ReadonlySet<string>;
  readonly adminWorkspaces: readonly string[];
  /** Administrators may switch Sessions and receive Workspace-scoped notices. */
  isAdmin(user: string): boolean;
  /** Whether an administrator scope covers one Workspace directory. */
  adminWorkspaceAllowed(path: string | undefined): boolean;
  evaluate(parts: BindingKeyParts): AccessDecision;
}

export type AccessDecision =
  | { readonly accepted: true; readonly groupId?: string }
  | { readonly accepted: false; readonly reason: RejectionReason };

export interface AccessPolicyOptions {
  /** Membership lookup: the group this principal belongs to, if any. */
  memberOf(parts: BindingKeyParts): string | undefined;
}

export function createAccessPolicy(
  settings: Pick<BridgeSettings, 'adminUserIds' | 'adminWorkspaces'>,
  options: AccessPolicyOptions,
): AccessPolicy {
  const adminUserIds = new Set(settings.adminUserIds);
  const adminWorkspaces = settings.adminWorkspaces;
  return {
    adminUserIds,
    adminWorkspaces,
    isAdmin: user => adminUserIds.has(user),
    adminWorkspaceAllowed: (path: string | undefined) => pathListed(adminWorkspaces, path),
    evaluate(parts) {
      const member = options.memberOf(parts);
      if (member) return { accepted: true, groupId: member };
      if (parts.chatType === 'single' && adminUserIds.has(parts.user)) return { accepted: true };
      return { accepted: false, reason: 'unauthorized' };
    },
  };
}
