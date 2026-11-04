/**
 * DSH's own icons, read by name at render time.
 *
 * The shell's primitives module is the only place these come from, and an
 * icon renamed in a later DSH must not blank the whole plugin page: a missing
 * export renders nothing, and the label beside it still says what the control
 * does.
 */
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives';
import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives';
import type { ComponentType } from 'react';

function icon(name: string): ComponentType<IconProps> {
  function Icon(props: IconProps) {
    const Component = (primitives as unknown as Record<string, ComponentType<IconProps> | undefined>)[name];
    return Component ? <Component {...props} /> : null;
  }
  Icon.displayName = name;
  return Icon;
}

export const IconChevronRight = icon('IconChevronRightOutlineRegular');
export const IconPlus = icon('IconPlusOutlineRegular');
export const IconRefresh = icon('IconRefreshOutlineRegular');
export const IconTrash = icon('IconTrashOutlineRegular');
export const IconArchive = icon('IconArchiveOutlineRegular');
export const IconCopy = icon('IconCopyOutlineRegular');
export const IconCheck = icon('IconCheckOutlineRegular');
export const IconUser = icon('IconUserOutlineRegular');
export const IconUsers = icon('IconUsersOutlineRegular');
export const IconWarning = icon('IconWarningTriangleOutlineRegular');
export const IconOpen = icon('IconRightUpOutlineRegular');
