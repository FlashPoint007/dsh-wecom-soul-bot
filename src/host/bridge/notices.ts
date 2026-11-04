import type { ApprovalRequest, Question } from '../dsh.js';
import type { TurnSummary } from '../turns.js';
import type { OperableGroup } from './directory.js';
import type { WorkspaceOption } from '../../shared/protocol.js';
import {
  displayPath, displayTitle, formatDuration, limitBytes, MAX_NOTICE_BYTES, oneLine, sessionToken, shortId,
} from './format.js';

/**
 * Message templates.
 *
 * Untrusted short strings (titles, ids, tool names) go through {@link inline},
 * which swaps Markdown/HTML metacharacters for look-alikes instead of
 * backslash escapes, so nothing renders as a link, mention or tag. Assistant
 * text keeps its Markdown but loses HTML-like tags.
 *
 * Every notice and every command reply uses the same flat shape, so one chat
 * stays scannable:
 *
 *   **🏷 标题** · 《会话》        what happened, and to which Session
 *   > 上下文 / 操作提示            one line of grey context
 *
 *   - **字段**：值                 details, one per line
 *
 *   > 引用这条消息即可回到该会话
 *
 * Enterprise WeChat renders a Markdown subset (bold, inline code and quotes);
 * tables and nested lists come out as raw text, so nothing here is tabular or
 * nested — and every line still reads correctly if the styling is dropped.
 */

const INLINE_SWAP: Record<string, string> = { '*': '＊', '_': '＿', '`': 'ˋ', '[': '［', ']': '］', '<': '‹', '>': '›', '#': '＃' };

export function inline(text: string, maxBytes = 300): string {
  return limitBytes(oneLine(text).replace(/[*_`\[\]<>#]/g, char => INLINE_SWAP[char] ?? char), maxBytes);
}

/** Keep Markdown, but drop anything that could act as a tag or mention. */
export function markdownBody(text: string, maxBytes: number): string {
  return limitBytes(text.replace(/<(?=[@a-zA-Z\/!])/g, '‹'), maxBytes);
}

/** Bold text. Only ever called with the templates' own literals. */
export function bold(text: string): string {
  return `**${text}**`;
}

/** Inline code, for ids and commands the reader may want to copy verbatim. */
export function code(text: string): string {
  return `\`${text}\``;
}

/** `**🏷 标题**` — the first line of a notice or of a long command reply. */
export function title(emoji: string, text: string): string {
  return bold(`${emoji} ${text}`);
}

/** `**标签**：值` — one labelled detail line. */
export function field(label: string, value: string): string {
  return `${bold(label)}：${value}`;
}

export function sessionLabel(title: string | null | undefined): string {
  return `《${inline(displayTitle(title), 120)}》`;
}

/** `《标题》 · session-abc123…` — a Session named and identified in one line. */
export function sessionRef(title: string | null | undefined, sessionId: string): string {
  return `${sessionLabel(title)} · ${code(shortId(sessionId))}`;
}

/**
 * Appended to every per-Session notice: quoting (reply-to) the message in
 * WeCom, or typing `/use` with this token, jumps straight to that Session —
 * overriding whatever was selected before. See
 * {@link extractSessionPointer} in `format.ts` for the matching parse: the
 * token stays outside any inline-code span so the parser always sees it.
 */
export function quotePointer(sessionId: string): string {
  return `> 引用（回复）这条消息，或发送 /use ${sessionToken(sessionId)}，之后直接发消息即可继续这个会话。`;
}

export const HELP_TEXT = [
  title('📖', '企业微信 · DSH 机器人'),
  '',
  '直接把消息发给我，就会进入你的专属 DSH 会话；本轮结束后，我会把结果发回这里。',
  '',
  bold('💬 常用命令'),
  '- **/status** — 当前会话的 Workspace、preset、模型、effort、上下文与运行状态',
  '- **/whoami** — 查看你的 userid、所属分组与管理员身份',
  `- **/compact** — 压缩当前会话的上下文：${code('/compact')}（群聊里需要管理员）`,
  `- **/delete** — 归档当前会话，清空它的记忆：${code('/delete')} 后再发 ${code('/delete confirm')}（群聊里需要管理员）`,
  '- **/cancel** — 停止你的会话正在运行的回合',
  `- **/answer** — 回答 DSH 的提问：${code('/answer 验证码 选项序号或文字')}`,
  `- **/approve** — 允许本次工具调用：${code('/approve 验证码')}（管理员单聊，与 DSH 页面同时可用）`,
  `- **/deny** — 拒绝本次工具调用：${code('/deny 验证码')}`,
  '- **/help** — 显示这份说明',
  '',
  bold('🔗 引用定位'),
  '引用（回复）我发出的某条通知，之后的消息就会继续那条通知所属的会话。',
  '',
  bold('🔒 管理员命令'),
  '只有插件配置中列出的管理员可以使用，并且只能在单聊里发送：群聊里的会话是所有人共用的，这些命令不会在群里执行。',
  '- **/new** — 在默认 Workspace 中新建一个会话并切换过去',
  '- **/workspaces** — 查看 DSH 的 Workspace 列表，并选择你的默认 Workspace',
  '- **/sessions** — 按 Workspace 列出可切换的会话',
  `- **/use** — 切换要操作的会话：${code('/use 序号')} 或 ${code('/use 会话ID前缀')}`,
  '- **/reset** — 放弃切换，回到自己的专属会话',
].join('\n');

export function adminOnlyText(): string {
  return [
    title('🔒', '需要管理员权限'),
    '',
    '这个命令只有插件配置里列出的管理员可以使用。你的消息会进入自己的专属会话；需要清空记忆时发送 **/delete**。',
  ].join('\n');
}

/**
 * An administrator command sent from a group chat. The sender may well be an
 * administrator, and the refusal is not about rank: it is about the Session
 * being shared, so a group chat must not create one, switch it, or answer an
 * approval on everybody's behalf.
 */
export function adminPrivateOnlyText(): string {
  return [
    title('🔒', '管理员命令只能在单聊中使用'),
    '',
    '群聊里的会话是所有人共用的，这类命令会新建或切换会话、选定 Workspace，或替所有人审批工具调用，所以不在这里执行。',
    '请在与机器人的单聊里发送这条命令。',
  ].join('\n');
}

/**
 * A member asking a group chat to compact or archive its Session.
 *
 * This is not the same refusal as {@link adminOnlyText}: the problem is not the
 * sender's rank but the Session itself, which everybody in the group shares.
 * The reply therefore names the real obstacle and points at the private chat,
 * where the person's own Session — the one they probably meant — lives.
 */
export function groupSessionRefusalText(command: string): string {
  const deleting = command === 'delete';
  const action = deleting ? '归档' : '压缩';
  return [
    title('🔒', `群聊的会话记录只有管理员可以${action}`),
    '',
    `这个群聊里的会话记录是所有人共用的，只有插件配置里列出的管理员才有权限${action}它。`,
    `> 如果你想${deleting ? '清空' : action}的是自己的专属会话，请在与机器人的单聊里发送 ${code(`/${command}`)}。`,
  ].join('\n');
}

/** A sender that is in no group: the Bot answers instead of staying silent. */
export function unauthorizedText(): string {
  return [
    title('🔒', '用户未授权'),
    '',
    '请联系管理员把你加入分组后再试。',
  ].join('\n');
}

/** An administrator's role never silently creates a group membership. */
export function adminUnassignedText(): string {
  return [
    title('ℹ️', '尚未加入分组或选择会话'),
    '> 管理员权限不会自动把你加入默认分组。',
    `请先发送 ${code('/new')} 新建会话，或发送 ${code('/sessions')} 查看并选择会话；也可以在插件主页把自己加入指定分组。`,
  ].join('\n');
}

export function questionAccessRefusalText(): string {
  return [
    title('🔒', '该提问不属于你当前可操作的会话'),
    '> 分组或会话可能已经变更，请在 DSH 页面处理原会话的提问。',
  ].join('\n');
}

/** A concurrent membership edit must not submit the message to the old Session. */
export function routingChangedText(): string {
  return [
    title('↩️', '分组或会话已变更'),
    '> 本条消息未提交，请重新发送；后续消息会按最新分组与会话设置处理。',
  ].join('\n');
}

/** Sent once, when the page authorizes a principal into its first group. */
export function authorizedNotice(groupName: string): string {
  return [
    title('✅', '管理员已授权，可以开始使用了'),
    '',
    `你已经被加入「${inline(groupName, 60)}」，直接发消息即可。`,
    `> 回复 ${code('/help')} 可以获取更多信息。`,
  ].join('\n');
}

/** Sent when an operator moves an existing principal to another group. */
export function groupAssignedNotice(groupName: string): string {
  return [
    title('🔀', '你已被调整到新的分组'),
    '',
    `你现在属于「${inline(groupName, 60)}」。`,
    '> 之前分组的会话绑定已解除；若你曾在目标分组拥有仍可用的历史会话，将恢复那个会话，否则下一条消息按目标分组的 Workspace、模型与预设新建会话。',
    '- **历史记录**：各分组的旧会话分别保留，不会迁移到其它分组。',
  ].join('\n');
}

/**
 * Sent once, when an operator adds a user to the administrator list.
 *
 * The notice names what changed and the boundary that surprises people most:
 * administrator commands still have to come from a private chat.
 */
export function adminGrantedNotice(): string {
  return [
    title('🔑', '你已被设为管理员'),
    '',
    '> 管理员命令现在可以使用；工具调用审批通知也会发到你的单聊。',
    '管理员权限不会自动把你加入任何分组；未选择会话时，请先新建或选择一个会话。',
    '',
    `- ${field('命令', `${code('/new')} 新建会话，${code('/sessions')} 列出会话，${code('/workspaces')} 选择默认 Workspace`)}`,
    '- **注意**：管理员命令只能在单聊里发送。',
    `> 回复 ${code('/help')} 查看完整说明。`,
  ].join('\n');
}

/** `/workspaces` reply: the DSH Workspace list and the operator's choice. */
export function workspaceListText(workspaces: readonly WorkspaceOption[], selected: string): { text: string; listing: string[] } {
  const listing = workspaces.map(workspace => workspace.path);
  if (!workspaces.length) {
    return {
      text: [
        title('🗂', 'DSH Workspace'),
        '',
        '还没有注册任何 Workspace：DSH 在第一次创建会话时才会注册它。直接发送 /new 可以在插件自带的 Workspace 里建一个，然后这里就会列出来。',
      ].join('\n'),
      listing,
    };
  }
  const rows = workspaces.map((workspace, index) => {
    const mark = selected && workspace.path === selected ? '（当前默认）' : '';
    return `${index + 1}. ${inline(workspace.title, 60)} — ${inline(displayPath(workspace.path), 120)}${mark}`;
  });
  return {
    text: [
      `${title('🗂', 'DSH Workspace')} · 共 ${workspaces.length} 个`,
      '',
      ...rows,
      '',
      `发送 ${code('/workspaces 序号')} 选择默认 Workspace；${code('/sessions')} 与 ${code('/new')} 都在它里面操作。发送 ${code('/workspaces 0')} 取消限定。`,
    ].join('\n'),
    listing,
  };
}

/** `/delete` first reply: what is about to be lost, and how to confirm. */
export function deleteWarningText(sessionTitle: string | null, sessionId: string): string {
  return [
    `${title('🗑', '归档会话会清空它的记忆')} · ${sessionLabel(sessionTitle)}`,
    '',
    `确认后将归档 ${code(shortId(sessionId))}：这个会话不再被继续，历史不会再进入任何请求，下一条消息会在新会话里开始。`,
    '',
    `再发送一次 ${code('/delete confirm')} 确认；其它消息不会执行这个操作。`,
  ].join('\n');
}

export function deletedText(): string {
  return [
    title('🗑', '会话已归档'),
    '',
    '它的上下文记忆不会再被使用；下一条消息会按当前分组的 Workspace、模型与 preset 新建一个会话。',
  ].join('\n');
}

export function compactedText(items: number, tokens: number): string {
  return [
    title('🧹', '上下文已压缩'),
    '',
    `- ${field('合并', `${items} 条历史`)}`,
    `- ${field('释放', `约 ${tokens} tokens`)}`,
  ].join('\n');
}

export function nothingToCompactText(): string {
  return `${title('🧹', '没有可压缩的历史')} · 这个会话还很短，暂时不需要压缩。`;
}

export function newSessionText(workspaceTitle: string, sessionId: string): string {
  return [
    title('🆕', '已创建并切换到新会话'),
    '',
    `- ${field('Workspace', inline(workspaceTitle, 120))}`,
    `- ${field('会话', code(shortId(sessionId)))}`,
    '',
    '直接发消息即可开始；发送 /reset 可以回到自己的专属会话。',
  ].join('\n');
}

export function noWorkspaceText(): string {
  return [
    title('⚠️', '还没有注册任何 Workspace'),
    '',
    '先发送 /new 在插件自带的 Workspace 里建一个会话（DSH 会顺带注册它），再回来选序号。',
  ].join('\n');
}

export function sessionListText(
  groups: readonly OperableGroup[], selected: string | undefined, limit = 30, scope?: string,
): { text: string; listing: string[] } {
  const listing: string[] = [];
  const blocks: string[] = [];
  let truncated = 0;
  for (const group of groups) {
    const rows: string[] = [];
    for (const session of group.sessions) {
      if (listing.length >= limit) { truncated++; continue; }
      listing.push(session.sessionId);
      const marks = [session.running ? '运行中' : '', session.sessionId === selected ? '当前' : ''].filter(Boolean);
      rows.push(`${listing.length}. ${inline(displayTitle(session.title), 60)} · ${shortId(session.sessionId)}${marks.length ? `（${marks.join(' · ')}）` : ''}`);
    }
    if (rows.length) blocks.push([bold(`📁 ${inline(group.title, 60)}`), ...rows].join('\n'));
  }
  if (!listing.length) {
    return {
      text: [
        `${title('🗂', '可切换的会话')}${scope ? ` · ${inline(scope, 60)}` : ''}`,
        '',
        scope
          ? '这个 Workspace 里没有可切换的会话。发送 /workspaces 0 可以取消 Workspace 限定。'
          : '没有找到可切换的会话。请在 DSH 中创建会话，或检查管理员的 Workspace 范围。',
      ].join('\n'),
      listing,
    };
  }
  return {
    text: [
      `${title('🗂', '可切换的会话')} · 共 ${listing.length + truncated} 个${scope ? ` · ${inline(scope, 60)}` : ''}`,
      '',
      blocks.join('\n\n'),
      '',
      ...(truncated ? [`… 另有 ${truncated} 个未显示`, ''] : []),
      `发送 ${code('/use 序号')} 切换会话；发送 ${code('/reset')} 回到自己的专属会话。`,
    ].join('\n'),
    listing,
  };
}

export function turnCompleteNotice(summary: TurnSummary, info: { readonly title: string | null; readonly workspace?: string }): string {
  const meta = [
    info.workspace ? `Workspace ${inline(info.workspace, 120)}` : '',
    summary.durationMs !== undefined ? `用时 ${formatDuration(summary.durationMs)}` : '',
    summary.steps ? `${summary.steps} 步` : '',
  ].filter(Boolean).join(' · ');
  if (summary.reason === 'error') return sessionErrorNotice(summary.sessionId, info.title, info.workspace, summary.failure);
  const header = summary.reason === 'completed'
    ? `${title('✅', 'DSH 本轮完成')} · ${sessionLabel(info.title)}`
    : `${title('⚠️', `DSH 本轮结束（${inline(summary.reason, 40)}）`)} · ${sessionLabel(info.title)}`;
  const body = summary.assistantText
    ? markdownBody(summary.assistantText, MAX_NOTICE_BYTES - 700)
    : '本轮没有可展示的文本回复。';
  return [
    header,
    ...(meta ? [`> ${meta}`] : []),
    '',
    body,
    '',
    quotePointer(summary.sessionId),
  ].join('\n');
}

export function sessionErrorNotice(sessionId: string, sessionTitle: string | null, workspace?: string, failure?: { readonly code?: string; readonly status?: number }): string {
  return [
    `${title('❌', 'DSH 会话因错误终止')} · ${sessionLabel(sessionTitle)}`,
    '> 本轮已停止，请到 DSH 页面查看错误详情；原始错误内容不会外发。',
    ...(workspace ? [`- ${field('Workspace', inline(workspace, 120))}`] : []),
    ...(failure?.code ? [`- ${field('错误代码', inline(failure.code, 64))}`] : []),
    ...(failure?.status ? [`- ${field('HTTP 状态', String(failure.status))}`] : []),
    '', quotePointer(sessionId),
  ].join('\n');
}

export function interactionIgnoredText(): string {
  return [title('ℹ️', '该请求已处理或已结束'), '> 本次操作已忽略，不会覆盖先前的回答或审批；如需新操作，请查看最新请求。'].join('\n');
}

export function interactionSubmittedText(kind: 'question' | 'approval'): string {
  return [title('📨', kind === 'question' ? '答案已提交' : '审批结果已提交'), '> DSH 页面与企业微信同时可操作，以先处理的结果为准；提交回执不代表本入口一定先完成。'].join('\n');
}

export function questionNotice(sessionId: string, sessionTitle: string | null, questions: readonly Question[], nonce: string, timeoutMs: number): string {
  const single = questions.length === 1;
  const blocks = questions.map((question, index) => {
    const options = (question.options ?? []).map((option, n) =>
      `   ${n + 1}. ${inline(option.label, 200)}${option.description ? ` — ${inline(option.description, 300)}` : ''}`);
    const head = single ? '' : `${index + 1}. `;
    return [`${head}${inline(question.question, 600)}${question.multiSelect ? '（可多选）' : ''}`, ...options].join('\n');
  });
  const usage = single
    ? `回复 /answer ${nonce} 选项序号或文字`
    : `逐题回复 /answer ${nonce} 题目ID 选项序号或文字`;
  return [
    `${title('❓', 'DSH 等待你的回答')} · ${sessionLabel(sessionTitle)}`,
    '',
    blocks.join('\n\n'),
    '',
    `> ${usage}；DSH 页面也可同时回答，以先处理的结果为准。本验证码最长有效 ${Math.round(timeoutMs / 1000)} 秒，请求结束会提前失效。`,
    quotePointer(sessionId),
  ].join('\n');
}

export function reviewNotice(sessionId: string, sessionTitle: string | null): string {
  return [
    `${title('👀', 'DSH 等待审阅')} · ${sessionLabel(sessionTitle)}`,
    '> 这是计划审阅或含详细内容的提问，请到 DSH 页面查看并处理；企业微信不能代为确认。',
    quotePointer(sessionId),
  ].join('\n');
}

export function approvalNotice(sessionId: string, sessionTitle: string | null, request: ApprovalRequest, nonce?: string, timeoutMs?: number): string {
  const reason = request.displayReason?.zh ?? request.displayReason?.en ?? request.reason ?? '';
  const lines = [
    `${title('🔐', 'DSH 权限请求')} · ${sessionLabel(sessionTitle)}`,
    '',
    `- ${field('工具', code(inline(request.toolName, 120)))}`,
    ...(reason ? [`- ${field('原因', inline(reason, 600))}`] : []),
  ];
  lines.push('');
  lines.push(nonce
    ? `回复 /approve ${nonce} 允许本次调用，或 /deny ${nonce} 拒绝；DSH 页面同时可审批，以先处理的结果为准。验证码最长有效 ${Math.round((timeoutMs ?? 0) / 1000)} 秒，请求结束会提前失效。`
    : '请到 DSH 页面审批。');
  lines.push('', quotePointer(sessionId));
  return lines.join('\n');
}

export function promptFailedNotice(sessionId: string, sessionTitle: string | null): string {
  return [
    `${title('⚠️', 'DSH 提交失败')} · ${sessionLabel(sessionTitle)}`,
    '> DSH 未接受这条消息，请到 DSH 页面查看详情后重试。',
    quotePointer(sessionId),
  ].join('\n');
}
