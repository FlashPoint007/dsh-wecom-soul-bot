/**
 * Types for the DSH Web shell's shared UI primitives. The shell provides
 * this module to every client plugin at runtime (it is never bundled);
 * only the components and props this page uses are declared here.
 * Icons are read through `components/icons.tsx`, which tolerates a missing
 * export, so a renamed icon degrades to nothing instead of crashing the slot.
 */
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type {
    ButtonHTMLAttributes, ForwardRefExoticComponent, InputHTMLAttributes, KeyboardEvent, ReactElement,
    ReactNode, RefAttributes,
  } from 'react';

  export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: 'primary' | 'ghost' | 'outline' | 'toolbar';
    size?: 'md' | 'sm';
    icon?: ReactNode;
  }
  export const Button: ForwardRefExoticComponent<ButtonProps & RefAttributes<HTMLButtonElement>>;

  export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
    icon?: ReactNode;
  }
  /** `className` lands on the wrapper span; the rest on the `<input>`. */
  export const Input: ForwardRefExoticComponent<InputProps & RefAttributes<HTMLInputElement>>;

  export function Switch(props: {
    checked: boolean;
    onChange(next: boolean): void;
    label: string;
    disabled?: boolean;
    title?: string;
    className?: string;
  }): ReactElement;

  export type TagTone = 'outline' | 'solid' | 'neutral' | 'quiet' | 'success' | 'info' | 'warning' | 'danger';
  export function Tag(props: { tone?: TagTone; className?: string; children?: ReactNode }): ReactElement;

  export function StateDot(props: {
    state: 'done' | 'warning' | 'ongoing' | 'error' | 'idle';
    size?: number;
    className?: string;
  }): ReactElement;

  export interface ModalProps {
    open: boolean;
    onClose(): void;
    title: ReactNode;
    closeLabel: string;
    description?: ReactNode;
    children?: ReactNode;
    footer?: ReactNode;
    className?: string;
    contentClassName?: string;
    headless?: boolean;
    backdropBlur?: boolean;
    onKeyDownCapture?(event: KeyboardEvent<HTMLElement>): void;
  }
  /** Overlay dialog portalled to document.body; Escape and focus are handled for you. */
  export function Modal(props: ModalProps): ReactElement | null;

  export interface IconProps { size?: number; className?: string }

  export function writeClipboard(text: string): Promise<boolean>;
}
