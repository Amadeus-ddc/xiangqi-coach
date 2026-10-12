import { sendTeaching } from './turn-flow.mjs';

export const lessonPrompt = (kind, mode) => kind === 'position' ? '请分析摆好的当前局面，讲清双方威胁、行棋计划和可验证的变化。' : kind === 'explain' && mode === 'record' ? '请讲解这手录谱着法的目的、优缺点和更好的思路；红黑双方都由我录入。' : kind === 'review' ? '请根据这份复盘讲清最值得改进的走法，给我一个下次可用的判断方法。' : kind === 'hint'
  ? '只给一个观察提示，先引导我自己想，不公布最佳着法或完整答案。'
  : '请讲解这个回合双方走法的目的，以及我的走法最值得注意的一点。';

const instruction = '你是中文象棋教练。根据已验证证据用约100–180字直接回答，先说原因，再举2–4个已验证中文着法并给一个自查方法。双方实走看played，best是建议；source=reply_search是应手时的搜索。cp不是兵数或胜率，不编造强制应手、得子或杀棋。只要提示时仅给观察方向，不公布最佳着法或变例。不需要更多工具即可回答时直接完成。';

export async function deliverInlineLesson({ app, lesson, call }) {
  const prompt = lessonPrompt(lesson.kind, lesson.evidence?.mode);
  if (app.getHostCapabilities()?.sampling) {
    // Hosts that support direct completion can keep the entire request inside
    // the component. A rejected request is not rerouted around host approval.
    const result = await app.createSamplingMessage({
      systemPrompt: instruction,
      messages: [{ role: 'user', content: { type: 'text', text: `${prompt}\n${JSON.stringify(lesson.evidence)}` } }],
      maxTokens: 900, includeContext: 'none',
    }, { timeout: 120000 });
    const blocks = Array.isArray(result.content) ? result.content : [result.content];
    const text = blocks.filter(block => block?.type === 'text').map(block => block.text).join('\n').trim();
    if (!text) throw new Error('教练没有返回可显示的正文，请重试。');
    const saved = await call('publish_lesson', { gameId: lesson.gameId, requestId: lesson.requestId, text });
    return { mode: 'inline', lesson: saved.lesson };
  }
  await sendTeaching({ app, prompt, evidence: {
    ...lesson.evidence,
    requestId: lesson.requestId,
    boardDelivery: { tool: 'publish_lesson', gameId: lesson.gameId, requestId: lesson.requestId, instructions: '完成正文后必须调用 publish_lesson 写回原棋盘。不要在主对话重复正文，不要新建棋盘。缺少证据时用 read_lesson(includeEvidence=true) 读取这条请求。' },
  } });
  return { mode: 'conversation' };
}

export function sameLessonPosition(lesson, game) {
  if (!lesson || !game || lesson.gameId !== game.id || lesson.toPly > game.moves.length) return false;
  return lesson.rootFen === (lesson.toPly === 0 ? game.initialFen : game.moves[lesson.toPly - 1]?.fen);
}
